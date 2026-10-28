// Llamadas a la API local (app/server.py) con la clave de acceso.
const TOKEN_KEY = "lienzo-token";

(function captureToken() {
  const params = new URLSearchParams(location.search);
  const token = params.get("t");
  if (!token) return;
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) { window.__lienzoToken = token; }
  params.delete("t");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
})();

export function token() {
  try { return sessionStorage.getItem(TOKEN_KEY) || window.__lienzoToken || ""; } catch (e) { return window.__lienzoToken || ""; }
}

async function request(method, path, { json, body, headers = {}, raw = false } = {}) {
  const options = { method, headers: { "X-Lienzo-Token": token(), ...headers } };
  if (json !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(json);
  } else if (body !== undefined) {
    options.body = body;
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Error ${response.status}`);
  }
  return raw ? response : response.json();
}

export const api = {
  formats: () => request("GET", "/api/formatos"),
  templates: (width, height) => request("GET", `/api/plantillas?ancho=${width}&alto=${height}`),
  designs: () => request("GET", "/api/disenos"),
  createDesign: (data) => request("POST", "/api/disenos", { json: data }),
  design: (id) => request("GET", `/api/disenos/${id}`),
  saveDesign: (design, thumbnail) => request("PUT", `/api/disenos/${design.id}`, { json: { diseno: design, miniatura: thumbnail } }),
  deleteDesign: (id) => request("DELETE", `/api/disenos/${id}`),
  duplicateDesign: (id) => request("POST", `/api/disenos/${id}/duplicar`),
  assets: () => request("GET", "/api/imagenes"),
  upload: (file) => request("POST", "/api/imagenes", {
    body: file, headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name || "imagen") },
  }),
  deleteAsset: (id) => request("DELETE", `/api/imagenes/${id}`),
  exportFile: (data) => request("POST", "/api/exportar", { json: data, raw: !data.ruta }),
  saveFile: (blob, ruta) => request("POST", "/api/guardar-archivo", {
    body: blob, headers: { "Content-Type": "application/octet-stream", "X-Ruta": encodeURIComponent(ruta) },
  }),
  uploadVideo: (file, meta) => request("POST", "/api/videos", {
    body: file,
    headers: {
      "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name || "video"),
      "X-Width": String(meta.width), "X-Height": String(meta.height), "X-Duration": String(meta.duration),
    },
  }),
  removeBackground: (id, tolerancia) => request("POST", `/api/imagenes/${id}/quitar-fondo`, { json: { tolerancia } }),
  stockSearch: (q, pagina = 1) => request("GET", `/api/stock/buscar?q=${encodeURIComponent(q)}&pagina=${pagina}`),
  stockImport: (id) => request("POST", "/api/stock/importar", { json: { id } }),
  fonts: () => request("GET", "/api/fuentes"),
  fontGoogle: (familia) => request("POST", "/api/fuentes/google", { json: { familia } }),
  fontUpload: (file, family) => request("POST", "/api/fuentes/subir", {
    body: file,
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name || "fuente"),
      "X-Family": encodeURIComponent(family || "") },
  }),
  fontDelete: (familia) => request("DELETE", `/api/fuentes?familia=${encodeURIComponent(familia)}`),
  brand: () => request("GET", "/api/marca"),
  saveBrand: (brand) => request("PUT", "/api/marca", { json: brand }),
  aiStatus: () => request("GET", "/api/ia/estado"),
  aiSettings: (url, modelo) => request("PUT", "/api/ia/ajustes", { json: { url, modelo } }),
  aiWrite: (instruccion, idioma) => request("POST", "/api/ia/escribir", { json: { instruccion, idioma } }),
  aiRewrite: (texto, modo) => request("POST", "/api/ia/reescribir", { json: { texto, modo } }),
  aiDesign: (data) => request("POST", "/api/ia/diseno", { json: data }),
};

export function toast(text, ms = 2600) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), ms);
}

export const isDesktop = () => Boolean(window.pywebview && window.pywebview.api);
