const MAX_KEEPALIVE_BYTES = 60_000;
const DB_NAME = "lienzo-autosave";
const STORE_NAME = "pending";

export function hasPendingSave({ timerPending, requestsPending, revision, savedRevision }) {
  return timerPending || requestsPending > 0 || revision > savedRevision;
}

export function createOutbox(indexedDBImpl = globalThis.indexedDB) {
  let database;

  function open() {
    if (database) return database;
    if (!indexedDBImpl) return Promise.reject(new Error("IndexedDB no está disponible."));
    database = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("designId", "designId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("No se pudo abrir la copia local."));
      request.onblocked = () => reject(new Error("La copia local está ocupada."));
    });
    database.catch(() => { database = null; });
    return database;
  }

  async function put(entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(entry);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar la copia local."));
      transaction.onabort = () => reject(transaction.error || new Error("No se pudo guardar la copia local."));
    });
  }

  async function list(designId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).index("designId").getAll(designId);
      let entries = [];
      request.onsuccess = () => { entries = request.result || []; };
      transaction.oncomplete = () => resolve(entries);
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo leer la copia local."));
    });
  }

  async function remove(key, revision) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result?.revision === revision) store.delete(key);
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo limpiar la copia local."));
      transaction.onabort = () => reject(transaction.error || new Error("No se pudo limpiar la copia local."));
    });
  }

  return { put, list, remove };
}

export const autosaveOutbox = createOutbox();

export async function retryPendingSaves({ entries, updated, save, remove }) {
  let design = null;
  let currentUpdated = updated;
  let conflicts = 0;
  let failures = 0;
  const groups = new Map();
  for (const entry of entries) {
    const clientId = entry.clientId || entry.key;
    if (!groups.has(clientId)) groups.set(clientId, []);
    groups.get(clientId).push(entry);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => (
    Math.min(...a.map((entry) => entry.queuedAt)) - Math.min(...b.map((entry) => entry.queuedAt))
  ));
  for (const group of orderedGroups) {
    group.sort((a, b) => a.stage - b.stage || a.queuedAt - b.queuedAt);
    let predecessorSaved = false;
    let groupUpdated = currentUpdated;
    for (const entry of group) {
      try {
        const baseUpdated = predecessorSaved ? groupUpdated : entry.baseUpdated;
        const result = await save(entry.design, baseUpdated);
        currentUpdated = result.updated;
        groupUpdated = result.updated;
        predecessorSaved = true;
        design = entry.design;
        try {
          await remove(entry.key, entry.revision);
        } catch {
          failures += 1;
        }
      } catch (error) {
        failures += 1;
        if (error.status === 409) conflicts += 1;
        predecessorSaved = false;
        break;
      }
    }
  }
  return { design, updated: currentUpdated, conflicts, failures };
}

export function queuePagehideSave({ design, pending, accessToken, expectedUpdated, fetchImpl = fetch }) {
  if (!pending || !design?.id) return false;

  let body;
  try {
    body = JSON.stringify({ diseno: design, expected_updated: expectedUpdated });
    if (new Blob([body]).size > MAX_KEEPALIVE_BYTES) return false;
  } catch {
    return false;
  }

  try {
    Promise.resolve(fetchImpl(`/api/disenos/${design.id}`, {
      method: "PUT",
      keepalive: true,
      body,
      headers: { "Content-Type": "application/json", "X-Lienzo-Token": accessToken },
    })).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
