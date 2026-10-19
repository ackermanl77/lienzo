// Inicio: formatos, plantillas y la lista de diseños guardados.
import { api, toast } from "./api.js";
import { ICONS } from "./icons.js";
import { fitTextHeight, renderPage } from "./render.js";

const $ = (id) => document.getElementById(id);
const open = (id) => { location.href = `/editor?id=${id}`; };

async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message); }
}

function formatCard(fmt) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "format";
  const scale = 56 / Math.max(fmt.ancho, fmt.alto);
  card.innerHTML = `<div class="shape-box"><div class="shape" style="width:${Math.round(fmt.ancho * scale)}px;height:${Math.round(fmt.alto * scale)}px"></div></div>`;
  const name = document.createElement("b");
  name.textContent = fmt.nombre;
  const size = document.createElement("span");
  size.textContent = `${fmt.ancho} × ${fmt.alto} px`;
  card.append(name, size);
  card.addEventListener("click", () => run(async () => open((await api.createDesign({ formato: fmt.id })).id)));
  return card;
}

function templateCard(template) {
  const card = document.createElement("div");
  card.className = "card";
  const design = { width: 1080, height: 1080 };
  template.pagina.elements.forEach(fitTextHeight);
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.appendChild(renderPage(design, template.pagina, 260));
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<b></b><span class="muted small"></span>`;
  info.querySelector("b").textContent = template.nombre;
  info.querySelector("span").textContent = template.categoria;
  card.append(thumb, info);
  thumb.addEventListener("click", () => run(async () => {
    open((await api.createDesign({ formato: "instagram_post", plantilla: template.id, titulo: template.nombre })).id);
  }));
  return card;
}

function toolButton(icon, title, handler) {
  const b = document.createElement("button");
  b.className = "btn ghost icon";
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", (e) => { e.stopPropagation(); run(handler); });
  return b;
}

function designCard(item) {
  const card = document.createElement("div");
  card.className = "card";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (item.thumb) {
    const img = document.createElement("img");
    img.src = item.thumb;
    img.alt = "";
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = '<span class="muted small">Sin vista previa</span>';
  }
  thumb.addEventListener("click", () => open(item.id));
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = "<b></b><span class='muted small'></span>";
  info.querySelector("b").textContent = item.title;
  const when = new Date(item.updated * 1000).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
  info.querySelector("span").textContent = `${item.width} × ${item.height} px · ${item.pages} pág. · ${when}`;
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(
    toolButton("edit", "Abrir", async () => open(item.id)),
    toolButton("copy", "Duplicar", async () => { await api.duplicateDesign(item.id); await loadDesigns(); toast("Diseño duplicado."); }),
    toolButton("trash", "Eliminar", async () => {
      if (!confirm(`¿Eliminar «${item.title}»? No se puede deshacer.`)) return;
      await api.deleteDesign(item.id);
      await loadDesigns();
    }),
  );
  card.append(thumb, info, tools);
  return card;
}

async function loadDesigns() {
  const items = await api.designs();
  const box = $("designs");
  box.innerHTML = "";
  $("count").textContent = items.length ? `${items.length} diseño${items.length === 1 ? "" : "s"}` : "";
  if (!items.length) {
    box.innerHTML = '<div class="empty">Todavía no tienes diseños. Elige un formato o una plantilla para empezar.</div>';
    return;
  }
  items.forEach((item) => box.appendChild(designCard(item)));
}

$("custom").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => open((await api.createDesign({ ancho: Number($("custom-w").value), alto: Number($("custom-h").value) })).id));
});

run(async () => {
  const [formats, templates] = await Promise.all([api.formats(), api.templates(1080, 1080)]);
  formats.forEach((f) => $("formats").appendChild(formatCard(f)));
  templates.forEach((t) => $("templates").appendChild(templateCard(t)));
  await loadDesigns();
});
