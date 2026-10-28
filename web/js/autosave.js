const MAX_KEEPALIVE_BYTES = 60_000;

export function hasPendingSave({ timerPending, requestsPending, revision, savedRevision }) {
  return timerPending || requestsPending > 0 || revision > savedRevision;
}

export function queuePagehideSave({ design, pending, accessToken, fetchImpl = fetch }) {
  if (!pending || !design?.id) return false;

  let body;
  try {
    body = JSON.stringify({ diseno: design });
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
