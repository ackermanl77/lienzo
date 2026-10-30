// Lienzo: el editor. Un <canvas> muestra la página actual; encima se dibujan
// la selección, los tiradores y las guías. Cada cambio pasa por change() o
// por un gesto (arrastrar, deslizar) que guarda un punto de deshacer y
// programa el guardado automático.
import { api, isDesktop, toast, token } from "./api.js";
import {
  autosaveOutbox, hasPendingSave, queuePagehideSave, retryPendingSaves,
} from "./autosave.js";
import { GRAPHICS } from "./graphics.js";
import { ICONS } from "./icons.js";
import {
  ANIMATIONS, FONTS, History, PAGE_DURATION, PALETTE, SHAPES, SHORTCUTS, bounds, cellAt, center, clone, corners, describe,
  duplicateElement, elementAt, expandGroups, fontString, intersects, makeGraphic, makeImage, makeShape, makeTable,
  guideAt, makeDrawing, makeText, makeVideo, matchesSearch, newId, newPage, resizeBox, resizeDesign, rotate, rotateElements, rotationFromPointer, rulerStep, scaleElements, snap,
  tableInsertCol, tableInsertRow, tableRemoveCol, tableRemoveRow, toLocal, unionBounds,
} from "./model.js";
import { present, recordVideo, videoFormat } from "./player.js";
import {
  allVideos, drawElement, drawPage, fitTextHeight, layoutTable, loadDesignImages, loadImage, loadVideo,
  registerFonts, renderPage, usesVideo, videoFor,
} from "./render.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const viewport = $("viewport");
const css = getComputedStyle(document.documentElement);
const COLORS = {
  stage: css.getPropertyValue("--stage").trim() || "#e8e6f1",
  select: css.getPropertyValue("--select").trim() || "#6c3cf0",
  guide: css.getPropertyValue("--guide").trim() || "#ff2f92",
  ruleGuide: css.getPropertyValue("--rule-guide").trim() || "#00a3ff",
  ruler: css.getPropertyValue("--ruler").trim() || "#f7f6fb",
  rulerText: css.getPropertyValue("--ruler-text").trim() || "#6b6880",
};

// Reglas y guías (UI8): las reglas (Mayús+R, recordadas en este navegador) ocupan RULER px
// arriba y a la izquierda; de ellas se arrastran guías, que se guardan con la página.
const RULER = 20;
const RULERS_KEY = "lienzo.rulers";
const loadRulers = () => { try { return localStorage.getItem(RULERS_KEY) === "1"; } catch { return false; } };

const state = {
  design: null, pageIndex: 0, selection: [], zoom: 1, offset: { x: 0, y: 0 }, dpr: window.devicePixelRatio || 1,
  panel: "templates", interaction: null, hoverId: null, guides: [], marquee: null, editingId: null,
  clipboard: null, assets: [], templates: null, pending: null, spaceDown: false, drawMode: null,
  fonts: [], catalog: [], activeCell: null, stock: null, ai: null, busy: false, rulers: loadRulers(),
};
const history = new History(100);
const autosaveClientId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const page = () => state.design.pages[state.pageIndex];
const selected = () => page().elements.filter((el) => state.selection.includes(el.id));
const byId = (id) => page().elements.find((el) => el.id === id);
const snapshot = () => JSON.stringify({ design: state.design, pageIndex: state.pageIndex });

async function run(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e)); }
}

// =====================================================================
// cambios, deshacer y guardado
// =====================================================================
function change(fn) {
  const before = snapshot();
  fn();
  if (snapshot() !== before) {
    history.record(before);
    changed();
  } else {
    refresh();
  }
}

/** Para controles continuos (deslizadores, colores): un solo punto de deshacer por gesto. */
function live(fn) {
  if (!state.pending) state.pending = snapshot();
  fn();
  render();
  syncCtxbar();
  scheduleSave();
}

function settle() {
  if (state.pending && state.pending !== snapshot()) {
    history.record(state.pending);
    changed();
  }
  state.pending = null;
}

function changed() {
  refresh();
  scheduleSave();
  schedulePageThumbs();
}

function restore(text) {
  const data = JSON.parse(text);
  state.design = data.design;
  state.pageIndex = Math.min(data.pageIndex, state.design.pages.length - 1);
  state.selection = state.selection.filter((id) => byId(id));
  changed();
}

function undo() {
  commitTextEdit();
  const prev = history.undo(snapshot());
  if (prev) restore(prev);
}

function redo() {
  commitTextEdit();
  const next = history.redo(snapshot());
  if (next) restore(next);
}

let saveTimer = null;
let saving = Promise.resolve();
let saveRevision = 0;
let savedRevision = 0;
let pendingSaveRequests = 0;
let serverUpdated = 0;
let outboxStage = 0;
let outboxKey = "";
let outboxWrite = Promise.resolve();
function setStatus(text) { $("status").textContent = text; }

function writeOutboxEntry(entry) {
  const write = outboxWrite.catch(() => {}).then(() => autosaveOutbox.put(entry));
  outboxWrite = write.catch(() => {});
  return write;
}

function persistOutbox(design, revision, baseUpdated, key = outboxKey, stage = outboxStage) {
  const entry = {
    key, designId: design.id, clientId: autosaveClientId, stage, revision, baseUpdated,
    queuedAt: Date.now(), design: clone(design),
  };
  return writeOutboxEntry(entry);
}

async function rebaseOutboxAfter(stage, updated) {
  const entries = await autosaveOutbox.list(state.design.id);
  for (const entry of entries) {
    if (entry.clientId === autosaveClientId && entry.stage > stage) {
      await writeOutboxEntry({ ...entry, baseUpdated: updated });
    }
  }
}

function scheduleSave() {
  saveRevision += 1;
  setStatus("Cambios sin guardar…");
  persistOutbox(state.design, saveRevision, serverUpdated).catch(() => setStatus("Sin copia local…"));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const design = clone(state.design);
  const revision = saveRevision;
  const stage = outboxStage;
  const key = outboxKey;
  outboxStage += 1;
  outboxKey = `${design.id}:${autosaveClientId}:${outboxStage}`;
  pendingSaveRequests += 1;
  saving = saving.then(async () => {
    setStatus("Guardando…");
    try {
      const expectedUpdated = serverUpdated;
      try {
        await persistOutbox(design, revision, expectedUpdated, key, stage);
      } catch {
        setStatus("Sin copia local…");
      }
      const thumb = renderPage(design, design.pages[0], 360).toDataURL("image/png");
      const result = await api.saveDesign(design, thumb, expectedUpdated);
      serverUpdated = result.updated;
      try {
        await rebaseOutboxAfter(stage, serverUpdated);
        await autosaveOutbox.remove(key, revision);
      } catch {
        // El servidor ya confirmó; una entrada restante se resolverá como repetición idempotente.
      }
      if (revision === saveRevision) {
        savedRevision = revision;
        if (!saveTimer && pendingSaveRequests === 1) setStatus("Guardado");
      }
    } catch (e) {
      setStatus(e.status === 409 ? "Conflicto al guardar" : "Sin guardar");
      toast(e.status === 409
        ? "El diseño cambió en otra pestaña. Tu copia local sigue pendiente."
        : `No se pudo guardar: ${e.message}`);
    } finally {
      pendingSaveRequests -= 1;
    }
  });
  return saving;
}

// =====================================================================
// vista: zoom, desplazamiento y dibujo
// =====================================================================
function resizeCanvas() {
  state.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(viewport.clientWidth * state.dpr);
  canvas.height = Math.round(viewport.clientHeight * state.dpr);
  render();
  positionTextEditor();
}

function fit() {
  const pad = 48;
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const zoom = Math.min((w - pad * 2) / state.design.width, (h - pad * 2) / state.design.height);
  setZoom(Math.max(0.02, zoom), null);
  state.offset = { x: (w - state.design.width * state.zoom) / 2, y: (h - state.design.height * state.zoom) / 2 };
  render();
  positionTextEditor();
}

/** Cambia el zoom manteniendo fijo el punto de pantalla `anchor` (o el centro). */
function setZoom(zoom, anchor) {
  zoom = Math.min(4, Math.max(0.02, zoom));
  const a = anchor || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  const world = toWorldXY(a.x, a.y);
  state.zoom = zoom;
  state.offset = { x: a.x - world.x * zoom, y: a.y - world.y * zoom };
  $("zoom").value = Math.round(zoom * 100);
  $("zoom-out").textContent = `${Math.round(zoom * 100)} %`;
  render();
  positionTextEditor();
}

const toWorldXY = (x, y) => ({ x: (x - state.offset.x) / state.zoom, y: (y - state.offset.y) / state.zoom });
const toScreen = (p) => ({ x: p.x * state.zoom + state.offset.x, y: p.y * state.zoom + state.offset.y });
function eventPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let frame = 0;
function render() {
  if (!frame) frame = requestAnimationFrame(draw);
}

function draw() {
  frame = 0;
  if (!state.design) return;
  const { design, zoom, offset, dpr } = state;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.stage;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(offset.x, offset.y);
  ctx.scale(zoom, zoom);
  ctx.save();
  ctx.shadowColor = "rgba(20, 10, 60, .18)";
  ctx.shadowBlur = 18 / zoom;
  ctx.shadowOffsetY = 3 / zoom;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, design.width, design.height);
  ctx.restore();
  drawPage(ctx, design, page(), { skip: state.editingId });
  // lo seleccionado que sale de la página se ve tenue fuera de ella
  for (const el of selected()) {
    if (el.id === state.editingId) continue;
    const b = bounds(el);
    if (b.left < 0 || b.top < 0 || b.left + b.width > design.width || b.top + b.height > design.height) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-1e6, -1e6, 2e6, 2e6);
      ctx.rect(0, 0, design.width, design.height);
      ctx.clip("evenodd");
      ctx.globalAlpha = 0.35;
      drawElement(ctx, el);
      ctx.restore();
    }
  }
  if (state.interaction && state.interaction.type === "draw") drawLiveStroke(state.interaction);
  ctx.restore();
  drawOverlay();
  // los videos de la página se reproducen (sin sonido) mientras se ven
  if (usesVideo(page()) && !document.hidden) {
    for (const el of page().elements) {
      if (!el.fill || !el.fill.video) continue;
      loadVideo(el.fill.video);
      const v = videoFor(el.fill.video);
      if (v && v.paused) v.play().catch(() => {});
    }
    render();
  }
}

// ---- Dibujar a mano alzada (UI4) ----
function drawLiveStroke(it) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = state.drawMode.width;
  ctx.strokeStyle = state.drawMode.color;
  ctx.beginPath();
  it.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
  ctx.stroke();
  ctx.restore();
}

function setDrawMode(on) {
  if (on) {
    commitTextEdit();
    state.drawMode = state.drawMode || { color: state.drawColor || "#6c3cf0", width: state.drawWidth || 8 };
    state.selection = [];
  } else {
    state.drawMode = null;
  }
  canvas.style.cursor = on ? "crosshair" : "default";
  document.querySelectorAll("[data-draw-toggle]").forEach((b) => {
    b.setAttribute("aria-pressed", String(Boolean(on)));
    b.textContent = on ? "Terminar de dibujar" : "Dibujar a mano alzada";
  });
  refresh();
}

function drawBlock() {
  const b = block("Dibujar");
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Arrastra sobre la página para dibujar; cada trazo queda como un elemento. Esc termina.";
  const toggle = button(state.drawMode ? "Terminar de dibujar" : "Dibujar a mano alzada", "Dibujar a mano alzada", () => setDrawMode(!state.drawMode));
  toggle.dataset.drawToggle = "";
  toggle.setAttribute("aria-pressed", String(Boolean(state.drawMode)));
  toggle.classList.add("block");
  const color = document.createElement("input");
  Object.assign(color, { type: "color", value: (state.drawMode && state.drawMode.color) || state.drawColor || "#6c3cf0" });
  color.setAttribute("aria-label", "Color del trazo");
  color.addEventListener("input", () => {
    state.drawColor = color.value;
    if (state.drawMode) state.drawMode.color = color.value;
  });
  const width = document.createElement("input");
  Object.assign(width, { type: "range", min: 1, max: 60, value: (state.drawMode && state.drawMode.width) || state.drawWidth || 8 });
  width.setAttribute("aria-label", "Grosor del trazo");
  width.addEventListener("input", () => {
    state.drawWidth = Number(width.value);
    if (state.drawMode) state.drawMode.width = Number(width.value);
  });
  const row = document.createElement("div");
  row.className = "row";
  row.append(color, width);
  b.append(note, toggle, row);
  return b;
}

/** Esquinas en pantalla de la celda (r, c) de una tabla. */
function cellCorners(el, cell) {
  const L = layoutTable(el);
  const x = L.colX[cell.c], y = L.rowY[cell.r], w = L.colW[cell.c], h = L.rowH[cell.r];
  const c = center(el);
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    .map(([px, py]) => toScreen(rotate({ x: el.left + px, y: el.top + py }, c, el.rotation)));
}

/** La selección como un solo marco: el elemento, o la caja que contiene a varios. */
function selectionFrame() {
  const sel = selected();
  if (!sel.length) return null;
  if (sel.length === 1) return sel[0];
  return { ...unionBounds(sel), rotation: 0, multi: true };
}

function outline(el, width, dash = []) {
  const pts = corners(el).map(toScreen);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.setLineDash(dash);
  ctx.lineWidth = width;
  ctx.strokeStyle = COLORS.select;
  ctx.stroke();
  ctx.setLineDash([]);
}

function handleNames(el) {
  if (el.multi) return ["nw", "ne", "se", "sw"];
  if (el.type === "text" || el.type === "table" || (el.type === "shape" && el.kind === "line")) {
    return el.type === "shape" ? ["e", "w"] : ["nw", "ne", "se", "sw", "e", "w"];
  }
  const names = ["nw", "ne", "se", "sw"];
  if (el.width * state.zoom > 36) names.push("n", "s");
  if (el.height * state.zoom > 36) names.push("e", "w");
  return names;
}

const HANDLE_LOCAL = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};

function handles(el) {
  const c = center(el);
  const list = handleNames(el).map((name) => {
    const [fx, fy] = HANDLE_LOCAL[name];
    return { name, ...toScreen(rotate({ x: el.left + fx * el.width, y: el.top + fy * el.height }, c, el.rotation)) };
  });
  const below = rotate({ x: c.x, y: el.top + el.height + 30 / state.zoom }, c, el.rotation);
  list.push({ name: "rotate", ...toScreen(below) });
  return list;
}

function drawOverlay() {
  const sel = selected().filter((el) => el.id !== state.editingId);
  const hover = state.hoverId && !state.selection.includes(state.hoverId) ? byId(state.hoverId) : null;
  if (hover && !state.interaction) outline(hover, 1);
  for (const el of sel) outline(el, sel.length > 1 ? 1.5 : 2);
  if (sel.length > 1) {
    const b = unionBounds(sel);
    const a = toScreen({ x: b.left, y: b.top });
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.width * state.zoom, b.height * state.zoom);
    ctx.setLineDash([]);
  }
  if (sel.length === 1 && sel[0].type === "table" && state.activeCell && !textEditor) {
    const cell = state.activeCell;
    if (cell.r < sel[0].rows && cell.c < sel[0].cols) {
      const pts = cellCorners(sel[0], cell);
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.guide;
      ctx.stroke();
    }
  }
  const frame = selectionFrame();
  if (frame && sel.length && !sel.some((el) => el.locked) && !["move", "gmove"].includes(state.interaction?.type)) {
    for (const h of handles(frame)) {
      ctx.beginPath();
      if (h.name === "rotate") {
        ctx.arc(h.x, h.y, 9, 0, Math.PI * 2);
      } else {
        ctx.arc(h.x, h.y, h.name.length === 2 ? 6 : 5, 0, Math.PI * 2);
      }
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLORS.select;
      ctx.stroke();
      if (h.name === "rotate") {
        ctx.beginPath();
        ctx.arc(h.x, h.y, 4, -Math.PI * 0.9, Math.PI * 0.6);
        ctx.stroke();
      }
    }
  }
  if (sel.length === 1 && sel[0].locked) {
    const p = toScreen(corners(sel[0])[1]);
    ctx.fillStyle = COLORS.select;
    ctx.font = "13px Segoe UI";
    ctx.fillText("🔒", p.x + 4, p.y - 4);
  }
  ctx.strokeStyle = COLORS.ruleGuide;
  ctx.lineWidth = 1;
  for (const g of page().guides || []) {
    ctx.beginPath();
    if (g.axis === "x") {
      const x = Math.round(toScreen({ x: g.pos, y: 0 }).x) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, viewport.clientHeight);
    } else {
      const y = Math.round(toScreen({ x: 0, y: g.pos }).y) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(viewport.clientWidth, y);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = COLORS.guide;
  for (const g of state.guides) {
    ctx.beginPath();
    if (g.axis === "x") {
      const x = toScreen({ x: g.pos, y: 0 }).x;
      ctx.moveTo(x, 0); ctx.lineTo(x, viewport.clientHeight);
    } else {
      const y = toScreen({ x: 0, y: g.pos }).y;
      ctx.moveTo(0, y); ctx.lineTo(viewport.clientWidth, y);
    }
    ctx.stroke();
  }
  if (state.marquee) {
    const m = state.marquee;
    const a = toScreen({ x: m.left, y: m.top });
    ctx.fillStyle = "rgba(108, 60, 240, .08)";
    ctx.fillRect(a.x, a.y, m.width * state.zoom, m.height * state.zoom);
    ctx.strokeStyle = COLORS.select;
    ctx.strokeRect(a.x, a.y, m.width * state.zoom, m.height * state.zoom);
  }
  if (state.rulers) drawRulers();
}

/** Las reglas, en píxeles del diseño (0 = borde de la página), con números cada rulerStep(). */
function drawRulers() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const step = rulerStep(state.zoom), minor = step / 5;
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, w, RULER);
  ctx.fillRect(0, 0, RULER, h);
  ctx.strokeStyle = COLORS.rulerText;
  ctx.fillStyle = COLORS.rulerText;
  ctx.font = "10px Segoe UI, sans-serif";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const isMajor = (v) => Math.abs(v / step - Math.round(v / step)) < 1e-6;
  const startX = Math.floor(toWorldXY(RULER, 0).x / minor) * minor, endX = toWorldXY(w, 0).x;
  for (let v = startX; v <= endX; v += minor) {
    const x = Math.round(toScreen({ x: v, y: 0 }).x) + 0.5;
    if (x < RULER) continue;
    ctx.moveTo(x, RULER); ctx.lineTo(x, isMajor(v) ? 4 : RULER - 5);
    if (isMajor(v)) ctx.fillText(String(Math.round(v)), x + 3, 10);
  }
  const startY = Math.floor(toWorldXY(0, RULER).y / minor) * minor, endY = toWorldXY(0, h).y;
  for (let v = startY; v <= endY; v += minor) {
    const y = Math.round(toScreen({ x: 0, y: v }).y) + 0.5;
    if (y < RULER) continue;
    ctx.moveTo(RULER, y); ctx.lineTo(isMajor(v) ? 4 : RULER - 5, y);
    if (isMajor(v)) {
      ctx.save();
      ctx.translate(10, y - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(Math.round(v)), 0, 0);
      ctx.restore();
    }
  }
  ctx.moveTo(0, RULER + 0.5); ctx.lineTo(w, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, h);
  ctx.stroke();
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, RULER, RULER);
}

function toggleRulers() {
  state.rulers = !state.rulers;
  try { localStorage.setItem(RULERS_KEY, state.rulers ? "1" : "0"); } catch { /* sin almacenamiento: no se recuerda */ }
  toast(state.rulers ? "Reglas visibles: arrastra desde una para crear una guía" : "Reglas ocultas");
  render();
}

/** La guía bajo el puntero, solo con las reglas visibles (así no estorba al mover elementos). */
function ruleGuideAt(screen) {
  if (!state.rulers) return -1;
  return guideAt(page().guides, toWorldXY(screen.x, screen.y), 4 / state.zoom);
}

// =====================================================================
// ratón / lápiz: seleccionar, mover, cambiar tamaño, girar
// =====================================================================
function handleAt(screen) {
  const sel = selected();
  if (!sel.length || sel.some((el) => el.locked) || state.editingId || textEditor) return null;
  return handles(selectionFrame()).find((h) => Math.hypot(h.x - screen.x, h.y - screen.y) <= 10) || null;
}

const CURSORS = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"];
function cursorFor(name, rotation) {
  const base = { n: 0, ne: 1, e: 2, se: 3, s: 0, sw: 1, w: 2, nw: 3 }[name];
  return CURSORS[(base + Math.round(((rotation % 180) + 180) / 45)) % 4];
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.focus({ preventScroll: true });
  closeMenus();
  const screen = eventPoint(e);
  if (e.button === 1 || (e.button === 0 && state.spaceDown)) {
    state.interaction = { type: "pan", last: screen };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  commitTextEdit();
  const p = toWorldXY(screen.x, screen.y);
  if (state.drawMode) {
    state.interaction = { type: "draw", points: [p] };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  // Reglas (UI8): arrastrar desde una crea una guía; arrastrar una guía la mueve.
  const onRuler = state.rulers && (screen.x < RULER) !== (screen.y < RULER);
  const guideIndex = onRuler ? -1 : ruleGuideAt(screen);
  if (onRuler || guideIndex >= 0) {
    const before = snapshot();
    const guides = page().guides || (page().guides = []);
    let index = guideIndex;
    if (onRuler) {
      // de la regla de arriba sale una guía horizontal; de la izquierda, una vertical
      const axis = screen.y < RULER ? "y" : "x";
      guides.push({ axis, pos: Math.round(axis === "x" ? p.x : p.y) });
      index = guides.length - 1;
    }
    state.interaction = { type: "guide", index, before, overRuler: onRuler };
    canvas.setPointerCapture(e.pointerId);
    render();
    return;
  }
  const handle = handleAt(screen);
  if (handle) {
    const frame = selectionFrame();
    if (frame.multi) {
      const c = center(frame);
      state.interaction = {
        type: handle.name === "rotate" ? "grotate" : "gresize", handle: handle.name, frame: clone(frame),
        starts: clone(selected()), before: snapshot(), startAngle: Math.atan2(p.y - c.y, p.x - c.x),
      };
    } else {
      state.interaction = { type: handle.name === "rotate" ? "rotate" : "resize", handle: handle.name, start: clone(frame), before: snapshot() };
    }
  } else {
    const hit = elementAt(page(), p, 3 / state.zoom);
    if (hit) {
      // Un clic elige el grupo entero; Ctrl+clic, solo el elemento.
      const ids = e.ctrlKey ? [hit.id] : expandGroups(page(), [hit.id]);
      if (e.shiftKey) {
        state.selection = state.selection.includes(hit.id)
          ? state.selection.filter((id) => !ids.includes(id)) : [...new Set([...state.selection, ...ids])];
      } else if (!state.selection.includes(hit.id) || (e.ctrlKey && state.selection.length > 1)) {
        state.selection = ids;
      }
      state.activeCell = hit.type === "table" && state.selection.length === 1 ? cellAt(layoutTable(hit), toLocal(hit, p)) : null;
      state.interaction = {
        type: "move", origin: p, screen, moved: false, before: snapshot(),
        starts: selected().map((el) => ({ id: el.id, left: el.left, top: el.top, locked: el.locked })),
      };
    } else {
      if (!e.shiftKey) state.selection = [];
      state.activeCell = null;
      state.interaction = { type: "marquee", origin: p, keep: e.shiftKey ? [...state.selection] : [] };
    }
    refresh();
  }
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  const screen = eventPoint(e);
  const p = toWorldXY(screen.x, screen.y);
  const it = state.interaction;
  if (!it) {
    const overGuide = ruleGuideAt(screen);
    if (overGuide >= 0) {
      canvas.style.cursor = page().guides[overGuide].axis === "x" ? "ew-resize" : "ns-resize";
      return;
    }
    const handle = handleAt(screen);
    const hit = handle ? null : elementAt(page(), p, 3 / state.zoom);
    const hoverId = hit ? hit.id : null;
    if (hoverId !== state.hoverId) { state.hoverId = hoverId; render(); }
    canvas.style.cursor = state.spaceDown ? "grab" : state.drawMode ? "crosshair" : handle
      ? (handle.name === "rotate" ? "grab" : cursorFor(handle.name, selected()[0].rotation))
      : hit ? (hit.locked ? "default" : "move") : "default";
    return;
  }
  if (it.type === "pan") {
    state.offset.x += screen.x - it.last.x;
    state.offset.y += screen.y - it.last.y;
    it.last = screen;
    render();
    positionTextEditor();
  } else if (it.type === "move") {
    if (!it.moved && Math.hypot(screen.x - it.screen.x, screen.y - it.screen.y) < 3) return;
    it.moved = true;
    let dx = p.x - it.origin.x, dy = p.y - it.origin.y;
    const movable = it.starts.filter((s) => !s.locked);
    if (!movable.length) return;
    movable.forEach((s) => { const el = byId(s.id); el.left = s.left + dx; el.top = s.top + dy; });
    state.guides = [];
    if (!e.altKey) {
      const ids = new Set(movable.map((s) => s.id));
      const targets = page().elements.filter((el) => !ids.has(el.id)).map(bounds);
      const result = snap(unionBounds(movable.map((s) => byId(s.id))), targets, state.design, 6 / state.zoom, page().guides);
      movable.forEach((s) => { const el = byId(s.id); el.left += result.dx; el.top += result.dy; });
      state.guides = result.guides;
    }
    render();
  } else if (it.type === "resize") {
    const el = byId(it.start.id);
    const corner = it.handle.length === 2;
    const media = el.fill && (el.fill.image || el.fill.video);
    const keepAspect = corner && ((el.type === "text" || el.type === "table" || el.type === "graphic" || media) ? !e.shiftKey : e.shiftKey);
    const box = resizeBox(it.start, it.handle, p, keepAspect, 4 / state.zoom);
    if (el.type === "text" || el.type === "table") {
      if (corner) el.fontSize = Math.max(4, it.start.fontSize * (box.width / it.start.width));
      Object.assign(el, { left: box.left, top: box.top, width: box.width });
      fitTextHeight(el);
    } else if (el.type === "shape" && el.kind === "line") {
      Object.assign(el, { left: box.left, width: box.width, top: box.top });
    } else {
      Object.assign(el, box);
    }
    render();
    syncCtxbar();
  } else if (it.type === "rotate") {
    const el = byId(it.start.id);
    let angle = rotationFromPointer(it.start, p, e.shiftKey);
    if (e.shiftKey) angle = Math.round(angle / 15) * 15;
    el.rotation = angle;
    render();
  } else if (it.type === "gresize") {
    const box = resizeBox(it.frame, it.handle, p, true, 4 / state.zoom);
    for (const update of scaleElements(it.starts, it.frame, box)) {
      const el = byId(update.id);
      if (!el) continue;
      Object.assign(el, update);
      fitTextHeight(el);
    }
    render();
  } else if (it.type === "grotate") {
    const c = center(it.frame);
    let delta = ((Math.atan2(p.y - c.y, p.x - c.x) - it.startAngle) * 180) / Math.PI;
    if (e.shiftKey) delta = Math.round(delta / 15) * 15;
    for (const update of rotateElements(it.starts, c, delta)) Object.assign(byId(update.id) || {}, update);
    render();
  } else if (it.type === "draw") {
    const last = it.points[it.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * state.zoom >= 1.5) {
      it.points.push(p);
      render();
    }
  } else if (it.type === "guide") {
    const g = page().guides[it.index];
    g.pos = Math.round(g.axis === "x" ? p.x : p.y);
    it.overRuler = g.axis === "x" ? screen.x < RULER : screen.y < RULER;
    canvas.style.cursor = it.overRuler ? "no-drop" : g.axis === "x" ? "ew-resize" : "ns-resize";
    render();
  } else if (it.type === "marquee") {
    const left = Math.min(it.origin.x, p.x), top = Math.min(it.origin.y, p.y);
    state.marquee = { left, top, width: Math.abs(p.x - it.origin.x), height: Math.abs(p.y - it.origin.y) };
    const hits = expandGroups(page(), page().elements.filter((el) => intersects(bounds(el), state.marquee)).map((el) => el.id));
    state.selection = [...new Set([...it.keep, ...hits])];
    render();
  }
});

function endInteraction() {
  const it = state.interaction;
  state.interaction = null;
  if (it && it.type === "guide") {
    const guides = page().guides;
    const g = guides[it.index];
    const limit = g.axis === "x" ? state.design.width : state.design.height;
    // soltada sobre la regla o fuera de la página: se quita
    if (it.overRuler || g.pos < 0 || g.pos > limit) guides.splice(it.index, 1);
    if (!guides.length) delete page().guides;
  }
  if (it && it.type === "draw") {
    const stroke = makeDrawing(it.points, state.drawMode.color, state.drawMode.width);
    if (stroke) {
      change(() => { page().elements.push(stroke); });  // one undo step per stroke
    } else {
      render();
    }
    return;
  }
  state.guides = [];
  state.marquee = null;
  if (it && it.before && it.before !== snapshot()) {
    history.record(it.before);
    changed();
  } else {
    refresh();
  }
}
canvas.addEventListener("pointerup", endInteraction);
canvas.addEventListener("pointercancel", endInteraction);
canvas.addEventListener("pointerleave", () => { if (!state.interaction && state.hoverId) { state.hoverId = null; render(); } });

canvas.addEventListener("dblclick", (e) => {
  const screen = eventPoint(e);
  const hit = elementAt(page(), toWorldXY(screen.x, screen.y), 3 / state.zoom);
  if (hit && hit.type === "text") startTextEdit(hit);
  if (hit && hit.type === "table") startCellEdit(hit, cellAt(layoutTable(hit), toLocal(hit, toWorldXY(screen.x, screen.y))));
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.0015), eventPoint(e));
  } else {
    state.offset.x -= e.shiftKey ? e.deltaY : e.deltaX;
    state.offset.y -= e.shiftKey ? 0 : e.deltaY;
    render();
    positionTextEditor();
  }
}, { passive: false });

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const screen = eventPoint(e);
  const hit = elementAt(page(), toWorldXY(screen.x, screen.y), 3 / state.zoom);
  if (hit && !state.selection.includes(hit.id)) { state.selection = [hit.id]; refresh(); }
  openMenu(e.clientX, e.clientY, contextItems());
});

// =====================================================================
// edición de texto en el lienzo
// =====================================================================
let textEditor = null;

function startTextEdit(el) {
  if (el.locked) return;
  commitTextEdit();
  state.selection = [el.id];
  state.editingId = el.id;
  const ta = document.createElement("textarea");
  ta.className = "text-editor";
  ta.spellcheck = true;
  ta.value = el.text;
  textEditor = { ta, before: snapshot() };
  ta.addEventListener("input", () => {
    const current = byId(state.editingId);
    if (!current) return;
    current.text = ta.value;
    fitTextHeight(current);
    positionTextEditor();
    scheduleSave();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); commitTextEdit(); canvas.focus(); }
    e.stopPropagation();
  });
  ta.addEventListener("blur", () => commitTextEdit());
  viewport.appendChild(ta);
  positionTextEditor();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  refresh();
}

/** Editar una celda de una tabla (Tab / Mayús+Tab pasan de celda). */
function startCellEdit(el, cell) {
  if (!el || el.locked || !cell) return;
  commitTextEdit();
  state.selection = [el.id];
  state.activeCell = cell;
  const ta = document.createElement("textarea");
  ta.className = "text-editor cell-editor";
  ta.value = el.cells[cell.r][cell.c];
  textEditor = { ta, before: snapshot(), cell: { id: el.id, r: cell.r, c: cell.c } };
  ta.addEventListener("input", () => {
    const t = byId(el.id);
    if (!t) return;
    t.cells[cell.r][cell.c] = ta.value;
    fitTextHeight(t);
    positionTextEditor();
    render();
    scheduleSave();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); commitTextEdit(); canvas.focus(); }
    if (e.key === "Tab") {
      e.preventDefault();
      const t = byId(el.id);
      let { r, c } = cell;
      c += e.shiftKey ? -1 : 1;
      if (c >= t.cols) { c = 0; r += 1; }
      if (c < 0) { c = t.cols - 1; r -= 1; }
      commitTextEdit();
      if (r >= 0 && r < t.rows) startCellEdit(t, { r, c });
    }
    e.stopPropagation();
  });
  ta.addEventListener("blur", () => commitTextEdit());
  viewport.appendChild(ta);
  positionTextEditor();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  refresh();
}

function positionTextEditor() {
  if (!textEditor) return;
  if (textEditor.cell) {
    const { ta, cell } = textEditor;
    const el = byId(cell.id);
    if (!el) return;
    const L = layoutTable(el);
    const pts = cellCorners(el, cell);
    const cx = (pts[0].x + pts[2].x) / 2, cy = (pts[0].y + pts[2].y) / 2;
    const w = L.colW[cell.c] * state.zoom, h = L.rowH[cell.r] * state.zoom;
    const header = el.header && cell.r === 0;
    Object.assign(ta.style, {
      left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px`, padding: `${L.pad * state.zoom}px`,
      transform: `rotate(${el.rotation}deg)`, font: fontString({ ...el, bold: header }, el.fontSize * state.zoom),
      color: header ? el.headerColor : el.color, background: header ? el.headerFill : el.cellFill,
      textAlign: el.align, lineHeight: String(el.lineHeight), opacity: "1", textDecoration: "none",
    });
    return;
  }
  const el = byId(state.editingId);
  if (!el) return;
  const { ta } = textEditor;
  const c = toScreen(center(el));
  const w = el.width * state.zoom, h = el.height * state.zoom;
  Object.assign(ta.style, {
    left: `${c.x - w / 2}px`, top: `${c.y - h / 2}px`, width: `${w + 2}px`, height: `${h}px`,
    transform: `rotate(${el.rotation}deg)`, font: fontString(el, el.fontSize * state.zoom), color: el.color,
    textAlign: el.align, lineHeight: String(el.lineHeight), opacity: String(1 - el.transparency),
    textDecoration: el.underline ? "underline" : "none",
  });
}

function commitTextEdit() {
  if (!textEditor) return;
  const { ta, before, cell } = textEditor;
  textEditor = null;
  const id = cell ? cell.id : state.editingId;
  state.editingId = null;
  ta.remove();
  const el = byId(id);
  if (!cell && el && !el.text.trim()) {
    page().elements = page().elements.filter((x) => x.id !== id);
    state.selection = [];
  }
  if (before !== snapshot()) {
    history.record(before);
    changed();
  } else {
    refresh();
  }
}

// =====================================================================
// acciones sobre la selección
// =====================================================================
/** Las copias de elementos agrupados forman grupos nuevos. */
function freshGroups(copies) {
  const map = new Map();
  for (const el of copies) {
    if (!el.group) continue;
    if (!map.has(el.group)) map.set(el.group, newId());
    el.group = map.get(el.group);
  }
  return copies;
}

const isGroup = (sel) => sel.length > 1 && sel.every((el) => el.group && el.group === sel[0].group);

function groupSelection() {
  const sel = selected();
  if (sel.length < 2) return;
  const id = newId();
  change(() => sel.forEach((el) => { el.group = id; }));
  toast("Agrupado. Ctrl+clic elige un solo elemento del grupo.");
}

function ungroupSelection() {
  const sel = selected().filter((el) => el.group);
  if (!sel.length) return;
  change(() => sel.forEach((el) => { delete el.group; }));
}

function addElement(el) {
  commitTextEdit();
  change(() => {
    fitTextHeight(el);
    page().elements.push(el);
    state.selection = [el.id];
  });
}

function deleteSelection() {
  const ids = new Set(selected().filter((el) => !el.locked).map((el) => el.id));
  if (!ids.size) return;
  change(() => {
    page().elements = page().elements.filter((el) => !ids.has(el.id));
    state.selection = [];
  });
}

function duplicateSelection() {
  const sel = selected();
  if (!sel.length) return;
  change(() => {
    const copies = freshGroups(sel.map((el) => duplicateElement(el, 20)));
    page().elements.push(...copies);
    state.selection = copies.map((el) => el.id);
  });
}

function copySelection() {
  if (selected().length) state.clipboard = clone(selected());
}

function pasteClipboard() {
  if (!state.clipboard) return;
  change(() => {
    const copies = freshGroups(state.clipboard.map((el) => duplicateElement(el, 20)));
    state.clipboard = clone(copies);
    page().elements.push(...copies);
    state.selection = copies.map((el) => el.id);
  });
}

function arrange(where) {
  const sel = new Set(state.selection);
  if (!sel.size) return;
  change(() => {
    const list = page().elements;
    const picked = list.filter((el) => sel.has(el.id));
    const rest = list.filter((el) => !sel.has(el.id));
    if (where === "front") page().elements = [...rest, ...picked];
    else if (where === "back") page().elements = [...picked, ...rest];
    else {
      const step = where === "forward" ? 1 : -1;
      const order = step > 0 ? [...list.keys()].reverse() : [...list.keys()];
      for (const i of order) {
        const j = i + step;
        if (sel.has(list[i].id) && j >= 0 && j < list.length && !sel.has(list[j].id)) {
          [list[i], list[j]] = [list[j], list[i]];
        }
      }
    }
  });
}

/** Alinea a la página (un elemento) o entre sí (varios). */
function align(where) {
  const sel = selected().filter((el) => !el.locked);
  if (!sel.length) return;
  const area = sel.length > 1 ? unionBounds(sel) : { left: 0, top: 0, width: state.design.width, height: state.design.height };
  change(() => {
    for (const el of sel) {
      const b = bounds(el);
      let dx = 0, dy = 0;
      if (where === "left") dx = area.left - b.left;
      if (where === "center") dx = area.left + area.width / 2 - (b.left + b.width / 2);
      if (where === "right") dx = area.left + area.width - (b.left + b.width);
      if (where === "top") dy = area.top - b.top;
      if (where === "middle") dy = area.top + area.height / 2 - (b.top + b.height / 2);
      if (where === "bottom") dy = area.top + area.height - (b.top + b.height);
      el.left += dx;
      el.top += dy;
    }
  });
}

function toggleLock() {
  const sel = selected();
  if (!sel.length) return;
  const lock = !sel.every((el) => el.locked);
  change(() => sel.forEach((el) => { el.locked = lock; }));
}

function nudge(dx, dy) {
  const sel = selected().filter((el) => !el.locked);
  if (!sel.length) return;
  change(() => sel.forEach((el) => { el.left += dx; el.top += dy; }));
}

// =====================================================================
// menús emergentes
// =====================================================================
function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
}

function openMenu(x, y, items) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item === "-") { menu.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = item.label;
    if (item.disabled) b.disabled = true;
    b.addEventListener("click", () => { closeMenus(); item.action(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  setTimeout(() => document.addEventListener("pointerdown", function away(e) {
    if (!menu.contains(e.target)) { closeMenus(); document.removeEventListener("pointerdown", away, true); }
  }, true));
}

function positionItems() {
  const many = selected().length > 1;
  return [
    { label: "Traer adelante", action: () => arrange("forward") },
    { label: "Enviar atrás", action: () => arrange("backward") },
    { label: "Traer al frente", action: () => arrange("front") },
    { label: "Enviar al fondo", action: () => arrange("back") },
    "-",
    { label: many ? "Alinear a la izquierda" : "Izquierda de la página", action: () => align("left") },
    { label: many ? "Centrar horizontalmente" : "Centro de la página", action: () => align("center") },
    { label: many ? "Alinear a la derecha" : "Derecha de la página", action: () => align("right") },
    { label: many ? "Alinear arriba" : "Arriba de la página", action: () => align("top") },
    { label: many ? "Centrar verticalmente" : "Medio de la página", action: () => align("middle") },
    { label: many ? "Alinear abajo" : "Abajo de la página", action: () => align("bottom") },
  ];
}

function contextItems() {
  const has = selected().length > 0;
  const sel = selected();
  return [
    ...(sel.length > 1 && !isGroup(sel) ? [{ label: "Agrupar  (Ctrl+G)", action: groupSelection }] : []),
    ...(sel.some((el) => el.group) ? [{ label: "Desagrupar  (Ctrl+Shift+G)", action: ungroupSelection }] : []),
    { label: "Copiar  (Ctrl+C)", action: copySelection, disabled: !has },
    { label: "Pegar  (Ctrl+V)", action: pasteClipboard, disabled: !state.clipboard },
    { label: "Duplicar  (Ctrl+D)", action: duplicateSelection, disabled: !has },
    { label: "Eliminar  (Supr)", action: deleteSelection, disabled: !has },
    "-",
    ...(has ? positionItems() : []),
    ...(has ? ["-", { label: selected().every((el) => el.locked) ? "Desbloquear" : "Bloquear", action: toggleLock }] : []),
  ];
}

// =====================================================================
// barra de opciones del elemento
// =====================================================================
let ctxKey = "";
let syncers = [];

function button(content, title, handler, { icon = false, on = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn${icon ? " icon" : ""}${on ? " on" : ""}`;
  b.title = title;
  b.setAttribute("aria-label", title);
  if (ICONS[content]) b.innerHTML = ICONS[content]; else b.textContent = content;
  b.addEventListener("click", (e) => { e.stopPropagation(); run(async () => handler(e)); });
  return b;
}

function sep() { const s = document.createElement("span"); s.className = "sep"; return s; }

function colorInput(title, get, set) {
  const input = document.createElement("input");
  input.type = "color";
  input.title = title;
  input.setAttribute("aria-label", title);
  input.addEventListener("input", () => live(() => set(input.value)));
  input.addEventListener("change", settle);
  syncers.push(() => { const v = get(); if (v && document.activeElement !== input) input.value = v; });
  return input;
}

function rangeInput(label, min, max, step, get, set) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  Object.assign(input, { type: "range", min, max, step });
  input.addEventListener("input", () => live(() => set(Number(input.value))));
  input.addEventListener("change", settle);
  wrap.appendChild(input);
  syncers.push(() => { if (document.activeElement !== input) input.value = get(); });
  return wrap;
}

function numberInput(title, min, max, get, set) {
  const input = document.createElement("input");
  Object.assign(input, { type: "number", min, max, title });
  input.setAttribute("aria-label", title);
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) change(() => set(Math.min(max, Math.max(min, v))));
  });
  syncers.push(() => { if (document.activeElement !== input) input.value = Math.round(get() * 10) / 10; });
  return input;
}

function selectInput(title, options, get, set) {
  const select = document.createElement("select");
  select.title = title;
  select.setAttribute("aria-label", title);
  for (const [value, label] of options) select.add(new Option(label, value));
  select.addEventListener("change", () => change(() => set(select.value)));
  syncers.push(() => {
    const value = String(get());
    if (![...select.options].some((o) => o.value === value)) select.add(new Option(value, value));
    select.value = value;
  });
  return select;
}

function renderCtxbar() {
  const bar = $("ctxbar");
  const sel = selected();
  const key = `${state.pageIndex}|${sel.map((el) => `${el.id}:${el.type}:${el.fill && el.fill.image ? "i" : ""}:${el.locked}:${el.group || ""}`).join(",")}`;
  if (key === ctxKey) { syncCtxbar(); return; }
  ctxKey = key;
  syncers = [];
  bar.innerHTML = "";
  if (!sel.length) {
    const label = document.createElement("label");
    label.textContent = "Fondo de la página";
    label.appendChild(colorInput("Color de fondo", () => page().background.color, (v) => { page().background.color = v; }));
    bar.append(label, sep());
    const info = document.createElement("span");
    info.className = "muted small";
    info.textContent = "Selecciona un elemento para editarlo · doble clic en un texto para escribir · Ctrl+rueda para zoom";
    bar.appendChild(info);
    syncCtxbar();
    return;
  }
  const all = (pred) => sel.every(pred);
  const each = (fn) => (v) => sel.forEach((el) => fn(el, v));
  const first = sel[0];
  if (all((el) => el.type === "text")) {
    bar.append(
      selectInput("Fuente", fontOptions(), () => first.fontFamily, each((el, v) => { el.fontFamily = v; fitTextHeight(el); })),
      button("−", "Reducir tamaño", () => change(() => sel.forEach((el) => { el.fontSize = Math.max(4, Math.round(el.fontSize * 0.9)); fitTextHeight(el); }))),
      numberInput("Tamaño de letra", 4, 1000, () => first.fontSize, each((el, v) => { el.fontSize = v; fitTextHeight(el); })),
      button("+", "Aumentar tamaño", () => change(() => sel.forEach((el) => { el.fontSize = Math.round(el.fontSize * 1.1) + 1; fitTextHeight(el); }))),
      colorInput("Color del texto", () => first.color, each((el, v) => { el.color = v; })),
      button("B", "Negrita (Ctrl+B)", () => change(() => { const v = !first.bold; sel.forEach((el) => { el.bold = v; fitTextHeight(el); }); }), { on: first.bold }),
      button("I", "Cursiva (Ctrl+I)", () => change(() => { const v = !first.italic; sel.forEach((el) => { el.italic = v; fitTextHeight(el); }); }), { on: first.italic }),
      button("U", "Subrayado (Ctrl+U)", () => change(() => { const v = !first.underline; sel.forEach((el) => { el.underline = v; }); }), { on: first.underline }),
      button(first.align === "left" ? "alignLeft" : first.align === "right" ? "alignRight" : "alignCenter", "Alineación del texto", () => change(() => {
        const next = { left: "center", center: "right", right: "left" }[first.align];
        sel.forEach((el) => { el.align = next; });
      }), { icon: true }),
      selectInput("Interlineado", [["1", "1.0"], ["1.2", "1.2"], ["1.4", "1.4"], ["1.6", "1.6"], ["2", "2.0"]],
        () => String(first.lineHeight), each((el, v) => { el.lineHeight = Number(v); fitTextHeight(el); })),
      sep(),
    );
    ctxKey += "|" + [first.bold, first.italic, first.underline, first.align].join();
  } else if (all((el) => el.type === "table")) {
    const t = first;
    const flip = (field) => () => change(() => { const v = !t[field]; sel.forEach((el) => { el[field] = v; fitTextHeight(el); }); });
    bar.append(
      selectInput("Fuente", fontOptions(), () => t.fontFamily, each((el, v) => { el.fontFamily = v; fitTextHeight(el); })),
      numberInput("Tamaño de letra", 4, 400, () => t.fontSize, each((el, v) => { el.fontSize = v; fitTextHeight(el); })),
      colorInput("Color del texto", () => t.color, each((el, v) => { el.color = v; })),
      button(t.align === "left" ? "alignLeft" : t.align === "right" ? "alignRight" : "alignCenter", "Alineación", () => change(() => {
        const next = { left: "center", center: "right", right: "left" }[t.align];
        sel.forEach((el) => { el.align = next; });
      }), { icon: true }),
      sep(),
      button("Encabezado", "Mostrar u ocultar la fila de encabezado", flip("header"), { on: t.header }),
      labelled("", colorInput("Fondo del encabezado", () => t.headerFill, each((el, v) => { el.headerFill = v; })),
        colorInput("Texto del encabezado", () => t.headerColor, each((el, v) => { el.headerColor = v; }))),
      labelled("Celdas", colorInput("Fondo de las celdas", () => t.cellFill, each((el, v) => { el.cellFill = v; }))),
      button("Rayas", "Filas alternas de otro tono", flip("stripe"), { on: t.stripe }),
      labelled("Bordes", colorInput("Color de los bordes", () => t.borderColor, each((el, v) => { el.borderColor = v; })),
        numberInput("Grosor de los bordes", 0, 40, () => t.borderWidth, each((el, v) => { el.borderWidth = v; }))),
      sep(),
      button("+ Fila", "Agregar una fila debajo de la celda elegida", () => tableOp("addRow")),
      button("− Fila", "Quitar la fila de la celda elegida", () => tableOp("removeRow")),
      button("+ Col.", "Agregar una columna a la derecha de la celda elegida", () => tableOp("addCol")),
      button("− Col.", "Quitar la columna de la celda elegida", () => tableOp("removeCol")),
      sep(),
    );
    ctxKey += "|" + [t.header, t.stripe, t.align].join();
  } else if (all((el) => el.type === "draw")) {
    bar.append(
      labelled("Trazo",
        colorInput("Color del trazo", () => first.stroke.color, each((el, v) => { el.stroke.color = v; })),
        numberInput("Grosor del trazo", 1, 200, () => first.stroke.width, each((el, v) => { el.stroke.width = v; }))),
      sep(),
    );
  } else if (all((el) => el.type !== "text" && el.type !== "table")) {
    const filled = sel.filter((el) => !(el.fill && (el.fill.image || el.fill.video)));
    if (filled.length) {
      const label = document.createElement("label");
      label.textContent = "Color";
      label.appendChild(colorInput("Color de relleno", () => filled[0].fill.color || "#ffffff", (v) => filled.forEach((el) => { el.fill.color = v; })));
      bar.appendChild(label);
    }
    if (sel.length === 1 && first.fill && first.fill.image) {
      bar.appendChild(button("Quitar fondo", "Quitar un fondo liso de la imagen (crea una copia sin fondo)", () => removeBackground(first)));
    }
    if (all((el) => el.stroke && !(el.type === "shape" && el.kind === "line"))) {
      const border = document.createElement("label");
      border.textContent = "Borde";
      border.append(
        colorInput("Color del borde", () => first.stroke.color, each((el, v) => { el.stroke.color = v; if (!el.stroke.width) el.stroke.width = 4; })),
        numberInput("Grosor del borde", 0, 200, () => first.stroke.width, each((el, v) => { el.stroke.width = v; })),
      );
      bar.appendChild(border);
    }
    if (all((el) => el.type === "rect")) {
      bar.appendChild(rangeInput("Esquinas", 0, Math.round(Math.min(first.width, first.height) / 2), 1,
        () => first.radius, each((el, v) => { el.radius = v; })));
    }
    bar.appendChild(sep());
  }
  bar.append(
    rangeInput("Opacidad", 0, 100, 1, () => Math.round((1 - first.transparency) * 100), each((el, v) => { el.transparency = 1 - v / 100; })),
    sep(),
    button("Posición", "Orden y alineación", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, positionItems());
    }),
    button("Animar", "Animación de entrada", () => setPanel("animate", false)),
    ...(sel.length > 1 && !isGroup(sel) ? [button("group", "Agrupar (Ctrl+G)", groupSelection, { icon: true })] : []),
    ...(sel.some((el) => el.group) ? [button("Desagrupar", "Desagrupar (Ctrl+Shift+G)", ungroupSelection)] : []),
    button(sel.every((el) => el.locked) ? "lock" : "unlock", sel.every((el) => el.locked) ? "Desbloquear" : "Bloquear", toggleLock, { icon: true, on: sel.every((el) => el.locked) }),
    button("copy", "Duplicar (Ctrl+D)", duplicateSelection, { icon: true }),
    button("trash", "Eliminar (Supr)", deleteSelection, { icon: true }),
  );
  syncCtxbar();
}

function syncCtxbar() {
  syncers.forEach((fn) => fn());
}

function labelled(text, ...nodes) {
  const label = document.createElement("label");
  label.textContent = text;
  label.append(...nodes);
  return label;
}

/** Fuentes incorporadas + las descargadas o subidas. */
function fontOptions() {
  return [...new Set([...FONTS, ...state.fonts.map((f) => f.family)])].map((f) => [f, f]);
}

function tableOp(op) {
  const t = selected()[0];
  if (!t || t.type !== "table") return;
  const cell = state.activeCell && state.activeCell.r < t.rows && state.activeCell.c < t.cols ? state.activeCell : { r: t.rows - 1, c: t.cols - 1 };
  change(() => {
    if (op === "addRow") { tableInsertRow(t, cell.r + 1); state.activeCell = { r: cell.r + 1, c: cell.c }; }
    if (op === "removeRow") { tableRemoveRow(t, cell.r); state.activeCell = { r: Math.min(cell.r, t.rows - 1), c: cell.c }; }
    if (op === "addCol") { tableInsertCol(t, cell.c + 1); state.activeCell = { r: cell.r, c: cell.c + 1 }; }
    if (op === "removeCol") { tableRemoveCol(t, cell.c); state.activeCell = { r: cell.r, c: Math.min(cell.c, t.cols - 1) }; }
    fitTextHeight(t);
  });
}

async function removeBackground(el) {
  setStatus("Quitando el fondo…");
  const asset = await api.removeBackground(el.fill.image, 40);
  state.assets.unshift(asset);
  await loadImage(asset.id);
  change(() => { const target = byId(el.id); if (target) target.fill.image = asset.id; });
  toast("Listo: se quitó el fondo (la imagen original sigue en Subidos).");
  if (state.panel === "uploads") renderPanel();
}

// =====================================================================
// panel lateral
// =====================================================================
function setPanel(name, toggle = true) {
  const ws = $("workspace");
  if (toggle && state.panel === name && !ws.classList.contains("panel-closed")) {
    ws.classList.add("panel-closed");
  } else {
    state.panel = name;
    ws.classList.remove("panel-closed");
  }
  document.querySelectorAll(".rail button").forEach((b) => b.classList.toggle("active", b.dataset.panel === state.panel && !ws.classList.contains("panel-closed")));
  renderPanel();
  setTimeout(resizeCanvas, 0);
}

// ---- Kit de marca (UI4): colores, fuentes y logo guardados para todos los diseños ----
async function saveBrand(change) {
  state.brand = await api.saveBrand({ ...state.brand, ...change });
  renderPanel();
}

/** Un color de marca: a lo seleccionado (texto, relleno o trazo) o, sin selección, al fondo. */
function applyBrandColor(color) {
  const sel = selected().filter((el) => !el.locked);
  change(() => {
    if (!sel.length) { page().background.color = color; return; }
    for (const el of sel) {
      if (el.type === "text" || el.type === "table") el.color = color;
      else if (el.type === "draw") el.stroke.color = color;
      else if (el.fill && !el.fill.image && !el.fill.video) el.fill.color = color;
    }
  });
}

function applyBrandFont(family) {
  const texts = selected().filter((el) => !el.locked && (el.type === "text" || el.type === "table"));
  if (!texts.length) { toast("Selecciona un texto para usar la fuente."); return; }
  change(() => texts.forEach((el) => { el.fontFamily = family; fitTextHeight(el); }));
}

function removable(child, label, onRemove) {
  const wrap = document.createElement("span");
  wrap.className = "brand-item";
  const x = button("×", `Quitar ${label} del kit de marca`, onRemove);
  x.classList.add("brand-remove");
  wrap.append(child, x);
  return wrap;
}

function renderBrandPanel(panel) {
  const brand = state.brand;
  const colors = block("Colores de marca");
  const swatches = document.createElement("div");
  swatches.className = "brand-swatches";
  for (const color of brand.colores) {
    const sw = button("", `Usar ${color} (en lo seleccionado, o en el fondo)`, () => applyBrandColor(color));
    sw.className = "brand-swatch";
    sw.style.background = color;
    swatches.appendChild(removable(sw, color, () => saveBrand({ colores: brand.colores.filter((c) => c !== color) })));
  }
  const pick = document.createElement("input");
  Object.assign(pick, { type: "color", value: "#6c3cf0" });
  pick.setAttribute("aria-label", "Color para agregar");
  const addRow = document.createElement("div");
  addRow.className = "row";
  addRow.append(pick, button("Agregar color", "Agregar el color al kit de marca", () => saveBrand({ colores: [...brand.colores, pick.value] })));
  colors.append(swatches, addRow);

  const fonts = block("Fuentes de marca");
  for (const family of brand.fuentes) {
    const f = button(family, `Usar ${family} en el texto seleccionado`, () => applyBrandFont(family));
    f.style.fontFamily = family;
    f.classList.add("brand-font");
    fonts.appendChild(removable(f, family, () => saveBrand({ fuentes: brand.fuentes.filter((x) => x !== family) })));
  }
  const fontSelect = document.createElement("select");
  fontSelect.setAttribute("aria-label", "Fuente para agregar");
  for (const [value, text] of fontOptions()) fontSelect.add(new Option(text, value));
  const fontRow = document.createElement("div");
  fontRow.className = "row";
  fontRow.append(fontSelect, button("Agregar", "Agregar la fuente al kit de marca", () => saveBrand({ fuentes: [...brand.fuentes, fontSelect.value] })));
  fonts.appendChild(fontRow);

  const logo = block("Logo");
  const asset = brand.logo && state.assets.find((a) => a.id === brand.logo);
  if (asset) {
    const img = document.createElement("img");
    img.src = asset.url;
    img.alt = "";
    logo.appendChild(tile(img, "Agregar el logo a la página", () => addElement(makeImage(asset, state.design))));
    logo.appendChild(button("Quitar logo", "Quitar el logo del kit de marca", () => saveBrand({ logo: null })));
  } else {
    const images = state.assets.filter((a) => a.kind !== "video");
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = images.length ? "Elige una imagen subida como logo:" : "Sube tu logo en Subidos y elígelo aquí.";
    logo.appendChild(note);
    if (images.length) {
      const choose = document.createElement("select");
      choose.setAttribute("aria-label", "Imagen para el logo");
      for (const a of images) choose.add(new Option(a.name || a.id, a.id));
      const row = document.createElement("div");
      row.className = "row";
      row.append(choose, button("Usar como logo", "Guardar la imagen como logo de marca", () => saveBrand({ logo: choose.value })));
      logo.appendChild(row);
    }
  }
  panel.append(colors, fonts, logo);
}

// "Cambiar tamaño" (UI3): una copia del diseño en otro formato, con su contenido reubicado en
// proporción (model.resizeDesign); el original no cambia.
function resizeBlock() {
  const b = block("Cambiar tamaño");
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Crea una copia en otro formato y la abre; el diseño original no cambia.";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Formato de la copia");
  const custom = document.createElement("div");
  custom.className = "row";
  custom.setAttribute("role", "group");
  custom.setAttribute("aria-label", "Tamaño personalizado");
  const sizeInput = (label, value) => {
    const input = document.createElement("input");
    Object.assign(input, { type: "number", min: 40, max: 8000, value });
    input.setAttribute("aria-label", label);
    return input;
  };
  const w = sizeInput("Ancho en píxeles", state.design.width), h = sizeInput("Alto en píxeles", state.design.height);
  custom.append(w, document.createTextNode("×"), h);
  custom.hidden = true;
  const go = button("Crear copia en este tamaño", "Crear una copia del diseño en el tamaño elegido", async () => {
    const option = select.selectedOptions[0];
    const width = option.value === "custom" ? Math.round(Number(w.value)) : Number(option.dataset.width);
    const height = option.value === "custom" ? Math.round(Number(h.value)) : Number(option.dataset.height);
    if (!(width >= 40 && width <= 8000 && height >= 40 && height <= 8000)) {
      toast("El tamaño debe estar entre 40 y 8000 px.");
      return;
    }
    await resizeToCopy(width, height, option.value === "custom" ? `${width}×${height}` : option.dataset.name);
  });
  go.classList.add("block");
  select.addEventListener("change", () => { custom.hidden = select.value !== "custom"; });
  b.append(note, select, custom, go);
  api.formats().then((formats) => {
    for (const f of formats) {
      if (f.ancho === state.design.width && f.alto === state.design.height) continue;
      const option = new Option(`${f.nombre} (${f.ancho}×${f.alto})`, f.id);
      Object.assign(option.dataset, { width: f.ancho, height: f.alto, name: f.nombre });
      select.add(option);
    }
    select.add(new Option("Tamaño personalizado…", "custom"));
  }).catch((e) => toast(`No se pudieron leer los formatos: ${e.message}`));
  return b;
}

async function resizeToCopy(width, height, label) {
  saveNow();
  await saving;
  const created = await api.createDesign({ ancho: width, alto: height, titulo: `${state.design.title} (${label})`.slice(0, 120) });
  const resized = resizeDesign(state.design, width, height);
  const next = { ...resized, id: created.id, title: created.title, format: created.format, created: created.created };
  for (const page of next.pages) page.elements.forEach(fitTextHeight);
  const thumb = renderPage(next, next.pages[0], 360).toDataURL("image/png");
  await api.saveDesign(next, thumb);
  location.href = `/editor?id=${created.id}`;
}

function block(title) {
  const div = document.createElement("div");
  div.className = "block";
  if (title) {
    const h = document.createElement("h3");
    h.textContent = title;
    div.appendChild(h);
  }
  return div;
}

function tile(child, label, onClick) {
  const t = document.createElement("div");
  t.className = "tile";
  t.tabIndex = 0;
  t.setAttribute("role", "button");
  if (label) t.title = label;
  t.appendChild(child);
  if (label) {
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    t.appendChild(l);
  }
  t.addEventListener("click", () => run(onClick));
  t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(onClick); } });
  return t;
}

function shapePreview(kind) {
  const el = makeShape(kind, { width: 100, height: 100 });
  const scale = 56 / Math.max(el.width, el.height);
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const g = c.getContext("2d");
  g.translate(32 - (el.left + el.width / 2) * scale, 32 - (el.top + el.height / 2) * scale);
  g.scale(scale, scale);
  if (el.fill) el.fill.color = COLORS.select;
  drawElement(g, el);
  return c;
}

let panelToken = 0;
async function renderPanel() {
  const token = ++panelToken;
  const host = $("panel");
  const panel = document.createElement("div");
  const name = state.panel;
  if (name === "templates") {
    const b = block("Plantillas");
    const hint = document.createElement("p");
    hint.className = "muted small";
    hint.textContent = "Si la página actual está vacía la plantilla se aplica ahí; si no, se agrega como página nueva.";
    // Buscar y filtrar por categoría (UI5), como el buscador de Gráficos y Fotos.
    const search = document.createElement("input");
    Object.assign(search, { type: "search", id: "template-search", placeholder: "Buscar plantillas (oferta, menú, boda…)" });
    search.setAttribute("aria-label", "Buscar plantillas");
    const category = document.createElement("select");
    category.id = "template-category";
    category.setAttribute("aria-label", "Categoría de plantillas");
    category.add(new Option("Todas las categorías", ""));
    const grid = document.createElement("div");
    grid.className = "grid2";
    const none = document.createElement("p");
    none.className = "muted small";
    none.textContent = "Ninguna plantilla coincide.";
    none.hidden = true;
    b.append(hint, search, category, grid, none);
    panel.appendChild(b);
    // Cambiar tamaño, debajo de las plantillas (UI7); el tamaño de la barra superior lo abre.
    const resize = resizeBlock();
    panel.appendChild(resize);
    if (state.focusResize) {
      state.focusResize = false;
      requestAnimationFrame(() => { resize.scrollIntoView({ block: "start" }); resize.querySelector("select").focus(); });
    }
    if (!state.templates) state.templates = await api.templates(state.design.width, state.design.height);
    if (state.panel !== "templates") return;
    const tiles = [];
    for (const t of state.templates) {
      t.pagina.elements.forEach(fitTextHeight);
      const item = tile(renderPage(state.design, t.pagina, 130), t.nombre, () => applyTemplate(t));
      tiles.push([item, t]);
      grid.appendChild(item);
    }
    for (const cat of [...new Set(state.templates.map((t) => t.categoria).filter(Boolean))].sort()) category.add(new Option(cat, cat));
    const filter = () => {
      let shown = 0;
      for (const [item, t] of tiles) {
        item.hidden = !(matchesSearch(search.value, t.nombre, t.categoria) && (!category.value || t.categoria === category.value));
        if (!item.hidden) shown++;
      }
      none.hidden = shown > 0;
    };
    search.addEventListener("input", filter);
    category.addEventListener("change", filter);
  } else if (name === "elements") {
    const b = block("Formas y líneas");
    const grid = document.createElement("div");
    grid.className = "grid3";
    for (const s of SHAPES) grid.appendChild(tile(shapePreview(s.kind), s.label, () => addElement(makeShape(s.kind, state.design))));
    b.appendChild(grid);
    panel.appendChild(b);
    const tb = block("Tablas");
    const sizes = document.createElement("div");
    sizes.className = "grid3";
    for (const [rows, cols] of [[3, 2], [4, 3], [6, 4]]) {
      sizes.appendChild(tile(tablePreview(rows, cols), `${rows} × ${cols}`, () => addElement(makeTable(state.design, rows, cols))));
    }
    tb.appendChild(sizes);
    panel.appendChild(tb);
    renderGraphicsBlock(panel);
    panel.appendChild(drawBlock());
  } else if (name === "text") {
    const b = block("Texto");
    const presets = [
      ["heading", "Agregar un título", "font: 700 22px Arial"],
      ["subheading", "Agregar un subtítulo", "font: 700 16px Arial"],
      ["body", "Agregar un poco de texto", "font: 400 13px Arial"],
    ];
    for (const [kind, label, style] of presets) {
      const btn = document.createElement("button");
      btn.className = "text-btn";
      btn.style.cssText = style;
      btn.textContent = label;
      btn.addEventListener("click", () => addElement(makeText(kind, state.design)));
      b.appendChild(btn);
    }
    panel.appendChild(b);
    const combos = block("Combinaciones de fuentes");
    const pairs = [
      ["Impact", "Arial", "GRAN VENTA", "Solo este fin de semana"],
      ["Georgia", "Georgia", "Una historia", "contada con calma"],
      ["Segoe Script", "Segoe UI", "Con cariño", "para ti, de nuestra parte"],
      ["Bahnschrift", "Bahnschrift", "PROYECTO 2026", "Informe de resultados"],
    ];
    for (const [f1, f2, t1, t2] of pairs) {
      const btn = document.createElement("button");
      btn.className = "text-btn";
      btn.innerHTML = `<div style="font: 700 18px '${f1}'"></div><div style="font: 400 12px '${f2}'"></div>`;
      btn.children[0].textContent = t1;
      btn.children[1].textContent = t2;
      btn.addEventListener("click", () => addCombo(f1, f2, t1, t2));
      combos.appendChild(btn);
    }
    panel.appendChild(combos);
    renderFontsBlock(panel);
  } else if (name === "photos") {
    await renderStockPanel(panel);
  } else if (name === "ai") {
    await renderAIPanel(panel);
  } else if (name === "animate") {
    renderAnimatePanel(panel);
  } else if (name === "uploads") {
    const b = block("Tus imágenes y videos");
    const drop = document.createElement("div");
    drop.className = "dropzone";
    drop.innerHTML = "Arrastra imágenes o videos aquí<br><span class='small'>PNG, JPG, WEBP, GIF · MP4 o WEBM · también puedes pegar imágenes con Ctrl+V</span>";
    const pick = button("Subir archivos", "Subir imágenes", () => $("file-input").click());
    pick.classList.add("primary");
    pick.style.cssText = "width:100%;justify-content:center;margin-bottom:10px";
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); run(() => uploadFiles(e.dataTransfer.files, null)); });
    b.append(pick, drop);
    const grid = document.createElement("div");
    grid.className = "grid2";
    for (const asset of state.assets) {
      const isVideo = asset.kind === "video";
      const media = document.createElement(isVideo ? "video" : "img");
      media.src = asset.url;
      if (isVideo) Object.assign(media, { muted: true, preload: "metadata" });
      else media.alt = asset.name;
      const t = tile(media, "", async () => {
        if (isVideo) { await loadVideo(asset.id); addElement(makeVideo(asset, state.design)); }
        else addElement(makeImage(asset, state.design));
      });
      t.title = asset.credit ? asset.credit.text || `${asset.credit.title} · ${asset.credit.creator}` : asset.name;
      if (isVideo) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = `▶ ${Math.round(asset.duration || 0)} s`;
        t.appendChild(badge);
      }
      if (asset.credit) {
        const cr = document.createElement("button");
        cr.className = "credit";
        cr.textContent = "©";
        cr.title = "Agregar el crédito de la foto al diseño";
        cr.addEventListener("click", (e) => { e.stopPropagation(); addCredit(asset.credit); });
        t.appendChild(cr);
      }
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = "Quitar de Subidos";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        run(async () => {
          await api.deleteAsset(asset.id);
          state.assets = state.assets.filter((a) => a.id !== asset.id);
          renderPanel();
        });
      });
      t.appendChild(x);
      grid.appendChild(t);
    }
    if (!state.assets.length) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Aún no subiste imágenes ni videos.";
      b.appendChild(p);
    }
    b.appendChild(grid);
    panel.appendChild(b);
  } else if (name === "brand") {
    if (!state.brand) state.brand = await api.brand();
    if (state.panel !== "brand" || token !== panelToken) return;
    renderBrandPanel(panel);
  } else if (name === "background") {
    const b = block("Color de fondo");
    const grid = document.createElement("div");
    grid.className = "swatches";
    for (const color of PALETTE) {
      const s = document.createElement("button");
      s.className = "swatch";
      s.style.background = color;
      s.title = color;
      s.setAttribute("aria-label", `Fondo ${color}`);
      s.addEventListener("click", () => change(() => { page().background.color = color; }));
      grid.appendChild(s);
    }
    b.appendChild(grid);
    const custom = document.createElement("label");
    custom.className = "muted small";
    custom.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:10px";
    custom.textContent = "Otro color";
    custom.appendChild(colorInput("Otro color de fondo", () => page().background.color, (v) => { page().background.color = v; }));
    b.appendChild(custom);
    panel.appendChild(b);
    const bi = block("Imagen de fondo");
    if (page().background.image) {
      const remove = button("Quitar imagen de fondo", "Quitar imagen de fondo", () => change(() => { delete page().background.image; }));
      remove.style.marginBottom = "10px";
      bi.appendChild(remove);
    }
    const imgs = document.createElement("div");
    imgs.className = "grid2";
    for (const asset of state.assets.filter((a) => a.kind !== "video")) {
      const img = document.createElement("img");
      img.src = asset.url;
      img.alt = asset.name;
      imgs.appendChild(tile(img, "", () => change(() => { page().background.image = asset.id; })));
    }
    if (!state.assets.length) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Sube una imagen en «Subidos» para usarla de fondo.";
      bi.appendChild(p);
    }
    bi.appendChild(imgs);
    panel.appendChild(bi);
  } else if (name === "layers") {
    const b = block("Capas (de arriba hacia abajo)");
    const list = document.createElement("ul");
    list.className = "layers";
    const els = [...page().elements].reverse();
    for (const el of els) {
      const li = document.createElement("li");
      li.classList.toggle("sel", state.selection.includes(el.id));
      const label = document.createElement("span");
      label.textContent = `${el.group ? "▣ " : ""}${el.animation ? "✦ " : ""}${describe(el)}`;
      li.append(
        label,
        button(el.locked ? "lock" : "unlock", el.locked ? "Desbloquear" : "Bloquear", () => change(() => { el.locked = !el.locked; }), { icon: true }),
        button("up", "Subir", () => { state.selection = [el.id]; arrange("forward"); }, { icon: true }),
        button("down", "Bajar", () => { state.selection = [el.id]; arrange("backward"); }, { icon: true }),
      );
      li.addEventListener("click", () => { state.selection = [el.id]; refresh(); });
      list.appendChild(li);
    }
    if (!els.length) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Esta página no tiene elementos.";
      b.appendChild(p);
    }
    b.appendChild(list);
    panel.appendChild(b);
  }
  // Solo el último dibujo del panel se muestra (los paneles con esperas pueden cruzarse).
  if (token === panelToken) host.replaceChildren(...panel.childNodes);
}


// =====================================================================
// paneles nuevos: gráficos, fuentes, fotos, IA, animación
// =====================================================================
function tablePreview(rows, cols) {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 48;
  const g = c.getContext("2d");
  const w = 60 / cols, h = 44 / rows;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      g.fillStyle = r === 0 ? COLORS.select : r % 2 ? "#ffffff" : "#efedf7";
      g.fillRect(2 + k * w, 2 + r * h, w - 1, h - 1);
    }
  }
  return c;
}

function graphicPreview(name) {
  const el = makeGraphic(name, { width: 100, height: 100 }, COLORS.select);
  Object.assign(el, { left: 4, top: 4, width: 56, height: 56 });
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  drawElement(c.getContext("2d"), el);
  return c;
}

function renderGraphicsBlock(panel) {
  const b = block("Gráficos");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Buscar gráficos (estrella, nube, casa…)";
  search.setAttribute("aria-label", "Buscar gráficos");
  const grid = document.createElement("div");
  grid.className = "grid3";
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    grid.innerHTML = "";
    for (const g of GRAPHICS.filter((x) => !q || x.label.toLowerCase().includes(q) || x.cat.toLowerCase().includes(q))) {
      grid.appendChild(tile(graphicPreview(g.name), g.label, () => addElement(makeGraphic(g.name, state.design))));
    }
  };
  search.addEventListener("input", fill);
  fill();
  b.append(search, grid);
  panel.appendChild(b);
}

function renderFontsBlock(panel) {
  const b = block("Fuentes descargadas");
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Descarga fuentes de Google Fonts (necesita internet una vez) o sube un archivo .ttf, .otf, .woff o .woff2. Quedan en esta PC.";
  const row = document.createElement("div");
  row.className = "row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Nombre (p. ej. Playfair Display)";
  input.setAttribute("list", "font-catalog");
  input.setAttribute("aria-label", "Fuente de Google Fonts");
  const list = document.createElement("datalist");
  list.id = "font-catalog";
  for (const name of state.catalog) list.appendChild(new Option(name));
  const get = button("Descargar", "Descargar de Google Fonts", async (e) => {
    const name = input.value.trim();
    if (!name) { toast("Escribe el nombre de una fuente."); return; }
    e.currentTarget.disabled = true;
    setStatus(`Descargando ${name}…`);
    try {
      const font = await api.fontGoogle(name);
      await installedFont(font);
      toast(`Fuente «${font.family}» lista.`);
    } finally {
      setStatus("Guardado");
    }
  });
  row.append(input, get);
  const upload = button("Subir archivo de fuente", "Subir un archivo de fuente", () => $("font-input").click());
  upload.classList.add("block");
  const ul = document.createElement("ul");
  ul.className = "font-list";
  for (const f of state.fonts) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = f.family;
    name.style.fontFamily = `"${f.family}"`;
    li.append(name, button("trash", `Quitar ${f.family}`, async () => {
      await api.fontDelete(f.family);
      state.fonts = state.fonts.filter((x) => x.family !== f.family);
      ctxKey = "";
      refresh();
      renderPanel();
    }, { icon: true }));
    ul.appendChild(li);
  }
  if (!state.fonts.length) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = "Aún no hay fuentes descargadas.";
    ul.appendChild(li);
  }
  b.append(note, row, list, upload, ul);
  panel.appendChild(b);
}

async function installedFont(font) {
  state.fonts = [...state.fonts.filter((f) => f.family !== font.family), font];
  await registerFonts([font]);
  for (const p of state.design.pages) p.elements.forEach(fitTextHeight);
  ctxKey = "";
  refresh();
  if (state.panel === "text") renderPanel();
}

$("font-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  run(async () => {
    const family = prompt("Nombre de la fuente:", file.name.replace(/\.[^.]+$/, "").replace(/[-_](regular|bold|italic)$/i, ""));
    if (family === null) return;
    const font = await api.fontUpload(file, family);
    await installedFont(font);
    toast(`Fuente «${font.family}» instalada.`);
  });
});

function addCredit(credit) {
  const el = makeText("body", state.design);
  el.text = `Foto: «${credit.title}» de ${credit.creator} · ${credit.license}`;
  el.fontSize = Math.max(8, Math.round(Math.min(state.design.width, state.design.height) * 0.018));
  el.width = state.design.width * 0.9;
  el.left = state.design.width * 0.05;
  el.align = "left";
  fitTextHeight(el);
  el.top = state.design.height - el.height - state.design.height * 0.02;
  addElement(el);
}

async function renderStockPanel(panel) {
  const b = block("Fotos (Openverse)");
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Fotos con licencia Creative Commons que permiten uso comercial y modificación. Necesita internet. Cada foto guarda su crédito (botón © en Subidos).";
  const form = document.createElement("form");
  form.className = "row";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Buscar fotos (montaña, café, oficina…)";
  input.value = state.stock ? state.stock.q : "";
  input.setAttribute("aria-label", "Buscar fotos");
  const go = document.createElement("button");
  go.className = "btn primary";
  go.textContent = "Buscar";
  form.append(input, go);
  const grid = document.createElement("div");
  grid.className = "grid2";
  const more = document.createElement("button");
  more.className = "btn block";
  more.textContent = "Más resultados";
  more.classList.add("hidden");
  const show = () => {
    grid.innerHTML = "";
    const st = state.stock;
    if (!st) return;
    if (!st.results.length) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Sin resultados.";
      grid.appendChild(p);
    }
    for (const item of st.results) {
      const img = document.createElement("img");
      img.src = item.thumb;
      img.alt = item.credit.title;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      const t = tile(img, "", async () => {
        setStatus("Descargando la foto…");
        try {
          const asset = await api.stockImport(item.id);
          state.assets.unshift(asset);
          await loadImage(asset.id);
          addElement(makeImage(asset, state.design));
          toast(`Foto de ${item.credit.creator} (${item.credit.license}). El crédito queda en Subidos.`, 4000);
        } finally {
          setStatus("Guardado");
        }
      });
      t.title = `${item.credit.title} — ${item.credit.creator} (${item.credit.license})`;
      grid.appendChild(t);
    }
    more.classList.toggle("hidden", st.page >= st.pages);
  };
  const search = async (pageNo) => {
    const q = input.value.trim();
    if (!q) return;
    go.disabled = more.disabled = true;
    try {
      const result = await api.stockSearch(q, pageNo);
      state.stock = pageNo > 1 && state.stock
        ? { ...result, q, results: [...state.stock.results, ...result.results] }
        : { ...result, q };
      show();
    } finally {
      go.disabled = more.disabled = false;
    }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); run(() => search(1)); });
  more.addEventListener("click", () => run(() => search(state.stock.page + 1)));
  b.append(note, form, grid, more);
  panel.appendChild(b);
  show();
}

async function renderAIPanel(panel) {
  const head = block("IA local");
  const status = document.createElement("p");
  status.className = "note";
  status.textContent = "Comprobando el servidor de IA…";
  head.appendChild(status);
  panel.appendChild(head);
  if (!state.ai) {
    try { state.ai = await api.aiStatus(); } catch (e) { state.ai = { ok: false, error: e.message, url: "", model: "", models: [] }; }
  }
  if (state.panel !== "ai") return;
  const ai = state.ai;
  status.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = `status-dot${ai.ok ? " ok" : ""}`;
  status.append(dot, ai.ok ? `Conectado (${ai.models.length} modelo${ai.models.length === 1 ? "" : "s"})` : ai.error || "Sin conexión");
  const url = document.createElement("input");
  url.type = "text";
  url.value = ai.url;
  url.setAttribute("aria-label", "Dirección del servidor de IA");
  const model = document.createElement("select");
  model.setAttribute("aria-label", "Modelo");
  model.add(new Option(ai.models.length ? "Primer modelo disponible" : "(sin modelos)", ""));
  for (const m of ai.models) model.add(new Option(m, m));
  model.value = ai.models.includes(ai.model) ? ai.model : "";
  const save = button("Guardar y probar", "Guardar la dirección y el modelo", async () => {
    await api.aiSettings(url.value, model.value);
    state.ai = null;
    renderPanel();
  });
  save.classList.add("block");
  const help = document.createElement("p");
  help.className = "note";
  help.textContent = "Usa un servidor de esta PC compatible con OpenAI: Ollama (http://127.0.0.1:11434/v1), LM Studio (http://127.0.0.1:1234/v1) o llama.cpp. El texto no sale de tu PC.";
  head.append(url, model, save, help);

  const busy = async (btn, fn) => {
    if (state.busy) return;
    state.busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "La IA está trabajando…";
    try { await fn(); } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = label;
      if (state.panel === "ai") renderPanel();
    }
  };

  const write = block("Escribir con IA");
  const prompt = document.createElement("textarea");
  prompt.placeholder = "Ej.: un eslogan corto para una cafetería de especialidad";
  const lang = document.createElement("select");
  lang.setAttribute("aria-label", "Idioma");
  lang.add(new Option("Español", "es"));
  lang.add(new Option("Inglés", "en"));
  const writeBtn = button("Escribir y agregar", "Escribir un texto con la IA", (e) => busy(e.currentTarget, async () => {
    const { texto } = await api.aiWrite(prompt.value, lang.value);
    const el = makeText(texto.length < 40 ? "heading" : texto.length < 90 ? "subheading" : "body", state.design);
    el.text = texto;
    el.width = state.design.width * 0.8;
    el.left = state.design.width * 0.1;
    addElement(el);
  }));
  writeBtn.classList.add("primary", "block");
  write.append(prompt, lang, writeBtn);
  panel.appendChild(write);

  const sel = selected();
  if (sel.length === 1 && sel[0].type === "text") {
    const rw = block("Reescribir el texto elegido");
    const chips = document.createElement("div");
    chips.className = "chips";
    const modes = [["shorter", "Más corto"], ["longer", "Más largo"], ["formal", "Formal"], ["fun", "Divertido"], ["fix", "Corregir"], ["en", "Al inglés"], ["es", "Al español"]];
    for (const [mode, label] of modes) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => run(() => busy(b, async () => {
        const el = sel[0];
        const { texto } = await api.aiRewrite(el.text, mode);
        change(() => { const t = byId(el.id); if (t) { t.text = texto; fitTextHeight(t); } });
      })));
      chips.appendChild(b);
    }
    rw.appendChild(chips);
    panel.appendChild(rw);
  }

  const magic = block("Diseño mágico");
  const desc = document.createElement("textarea");
  desc.placeholder = "Describe el diseño: «promoción de verano para una heladería, 2x1 los viernes»";
  const style = document.createElement("select");
  style.setAttribute("aria-label", "Estilo");
  for (const [v, l] of [["", "Estilo: que elija la IA"], ["audaz", "Audaz"], ["elegante", "Elegante"], ["minimalista", "Minimalista"], ["divertido", "Divertido"]]) style.add(new Option(l, v));
  const magicBtn = button("Crear página", "Crear una página nueva con la IA", (e) => busy(e.currentTarget, async () => {
    const pageData = await api.aiDesign({ descripcion: desc.value, ancho: state.design.width, alto: state.design.height, estilo: style.value, idioma: lang.value });
    applyTemplate({ pagina: pageData });
  }));
  magicBtn.classList.add("primary", "block");
  const mnote = document.createElement("p");
  mnote.className = "note";
  mnote.textContent = "La IA propone los textos, el estilo y los colores; Lienzo arma la página (si la actual tiene elementos, se agrega una nueva).";
  magic.append(desc, style, magicBtn, mnote);
  panel.appendChild(magic);

  const tools = block("Herramientas de imagen");
  const t = document.createElement("p");
  t.className = "note";
  t.textContent = "«Quitar fondo» (en la barra de una imagen elegida) borra un fondo liso: ideal para productos y logos sobre fondo uniforme. No usa IA ni internet.";
  tools.appendChild(t);
  panel.appendChild(tools);
}

function renderAnimatePanel(panel) {
  const sel = selected();
  const b = block(sel.length ? `Animación de entrada (${sel.length} elemento${sel.length === 1 ? "" : "s"})` : "Animación de entrada");
  if (!sel.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "Elige uno o más elementos en la página para animarlos.";
    b.appendChild(p);
  } else {
    const current = (sel[0].animation && sel[0].animation.type) || "none";
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const a of ANIMATIONS) {
      const btn = document.createElement("button");
      btn.textContent = a.label;
      btn.setAttribute("aria-pressed", String(a.type === current));
      btn.addEventListener("click", () => change(() => sel.forEach((el) => {
        if (a.type === "none") delete el.animation;
        else el.animation = { type: a.type, delay: el.animation ? el.animation.delay : 0, duration: el.animation ? el.animation.duration : 0.8 };
      })));
      chips.appendChild(btn);
    }
    b.appendChild(chips);
    if (current !== "none") {
      for (const [field, label, min, max] of [["duration", "Duración", 0.2, 4], ["delay", "Retraso", 0, 10]]) {
        const row = document.createElement("label");
        row.className = "slider";
        const input = document.createElement("input");
        Object.assign(input, { type: "range", min, max, step: 0.1, value: sel[0].animation[field] });
        const out = document.createElement("output");
        out.textContent = `${Number(input.value).toFixed(1)} s`;
        input.addEventListener("input", () => {
          out.textContent = `${Number(input.value).toFixed(1)} s`;
          live(() => sel.forEach((el) => { if (el.animation) el.animation[field] = Number(input.value); }));
        });
        input.addEventListener("change", settle);
        row.append(label, input, out);
        b.appendChild(row);
      }
    }
  }
  panel.appendChild(b);

  const pb = block(`Página ${state.pageIndex + 1}`);
  const durRow = document.createElement("div");
  durRow.className = "row";
  const durLabel = document.createElement("span");
  durLabel.className = "muted small";
  durLabel.textContent = "Duración (s)";
  const dur = document.createElement("input");
  Object.assign(dur, { type: "number", min: 0.5, max: 120, step: 0.5, value: page().duration || PAGE_DURATION });
  dur.setAttribute("aria-label", "Duración de la página en segundos");
  dur.addEventListener("change", () => {
    const v = Math.min(120, Math.max(0.5, Number(dur.value) || PAGE_DURATION));
    change(() => { page().duration = v; });
  });
  durRow.append(durLabel, dur);
  const all = button("Animar toda la página", "Una entrada escalonada para cada elemento", () => change(() => {
    page().elements.forEach((el, i) => {
      el.animation = { type: el.type === "text" ? "rise" : "fade", delay: Math.min(6, i * 0.25), duration: 0.8 };
    });
  }));
  all.classList.add("block");
  const none = button("Quitar animaciones de la página", "Quitar todas las animaciones", () => change(() => {
    page().elements.forEach((el) => { delete el.animation; });
  }));
  none.classList.add("block");
  const preview = button("▶ Vista previa", "Reproducir con animaciones", () => playDesign());
  preview.classList.add("primary", "block");
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Las animaciones se ven al reproducir y en la descarga en video. La duración de cada página marca cuánto dura en el video.";
  pb.append(durRow, all, none, preview, note);
  panel.appendChild(pb);
}

async function playDesign() {
  commitTextEdit();
  allVideos().forEach((v) => v.pause());
  await present(clone(state.design), state.pageIndex);
}

function addCombo(f1, f2, t1, t2) {
  const d = state.design;
  const title = makeText("heading", d);
  Object.assign(title, { text: t1, fontFamily: f1 });
  const sub = makeText("body", d);
  Object.assign(sub, { text: t2, fontFamily: f2 });
  title.width = sub.width = d.width * 0.7;
  title.left = sub.left = d.width * 0.15;
  fitTextHeight(title);
  fitTextHeight(sub);
  title.top = d.height / 2 - title.height;
  sub.top = d.height / 2 + title.fontSize * 0.2;
  change(() => {
    page().elements.push(title, sub);
    state.selection = [title.id, sub.id];
  });
}

function applyTemplate(template) {
  const fresh = clone(template.pagina);
  fresh.id = newId();
  fresh.elements.forEach((el) => { el.id = newId(); fitTextHeight(el); });
  freshGroups(fresh.elements);
  change(() => {
    if (page().elements.length) {
      state.design.pages.splice(state.pageIndex + 1, 0, fresh);
      state.pageIndex += 1;
      toast("La plantilla se agregó como página nueva.");
    } else {
      state.design.pages[state.pageIndex] = fresh;
    }
    state.selection = [];
  });
}

// =====================================================================
// imágenes: subir, soltar, pegar
// =====================================================================
/** Tamaño y duración de un video local (los mide el navegador). */
function videoMeta(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    v.preload = "metadata";
    v.onloadedmetadata = () => { resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration }); URL.revokeObjectURL(url); };
    v.onerror = () => { reject(new Error("No se pudo leer el video (¿formato MP4 o WEBM?).")); URL.revokeObjectURL(url); };
    v.src = url;
  });
}

async function uploadFiles(files, at) {
  const accepted = [...files].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type) || /^video\/(mp4|webm)$/.test(f.type));
  if (!accepted.length) { toast("Elige imágenes (PNG, JPG, WEBP, GIF) o videos (MP4, WEBM)."); return; }
  setStatus("Subiendo…");
  let i = 0;
  for (const file of accepted) {
    const point = at ? { x: at.x + i * 30, y: at.y + i * 30 } : null;
    if (file.type.startsWith("video/")) {
      const asset = await api.uploadVideo(file, await videoMeta(file));
      state.assets.unshift(asset);
      await loadVideo(asset.id);
      const el = makeVideo(asset, state.design);
      if (point) { el.left = point.x - el.width / 2; el.top = point.y - el.height / 2; }
      addElement(el);
    } else {
      const asset = await api.upload(file);
      state.assets.unshift(asset);
      await loadImage(asset.id);
      addElement(makeImage(asset, state.design, point));
    }
    i += 1;
  }
  if (state.panel === "uploads" || state.panel === "background") renderPanel();
  toast(accepted.length === 1 ? "Archivo agregado." : `${accepted.length} archivos agregados.`);
}

$("file-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  run(() => uploadFiles(files, null));
});

viewport.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); viewport.classList.add("dragover"); }
});
viewport.addEventListener("dragleave", (e) => { if (e.target === viewport || e.target === canvas) viewport.classList.remove("dragover"); });
viewport.addEventListener("drop", (e) => {
  e.preventDefault();
  viewport.classList.remove("dragover");
  const s = eventPoint(e);
  run(() => uploadFiles(e.dataTransfer.files, toWorldXY(s.x, s.y)));
});

let pasteTimer = null;
document.addEventListener("paste", (e) => {
  if (isTyping(e.target)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    clearTimeout(pasteTimer);
    run(() => uploadFiles(files, null));
  }
});

// =====================================================================
// páginas
// =====================================================================
let thumbsTimer = null;
function schedulePageThumbs() {
  clearTimeout(thumbsTimer);
  thumbsTimer = setTimeout(renderPages, 350);
}

function renderPages() {
  const box = $("pages");
  box.innerHTML = "";
  const height = 58;
  state.design.pages.forEach((p, i) => {
    const t = document.createElement("div");
    t.className = `page-thumb${i === state.pageIndex ? " active" : ""}`;
    t.title = `Página ${i + 1}`;
    t.tabIndex = 0;
    t.appendChild(renderPage(state.design, p, Math.max(20, (height * state.design.width) / state.design.height)));
    const n = document.createElement("span");
    n.textContent = i + 1;
    t.appendChild(n);
    t.addEventListener("click", () => goToPage(i));
    t.addEventListener("keydown", (e) => { if (e.key === "Enter") goToPage(i); });
    box.appendChild(t);
  });
  $("del-page").disabled = state.design.pages.length < 2;
}

function goToPage(i) {
  commitTextEdit();
  allVideos().forEach((v) => v.pause());
  state.pageIndex = i;
  state.selection = [];
  state.activeCell = null;
  refresh();
  renderPages();
}

$("add-page").addEventListener("click", () => change(() => {
  state.design.pages.splice(state.pageIndex + 1, 0, newPage());
  state.pageIndex += 1;
  state.selection = [];
}));
$("dup-page").addEventListener("click", () => change(() => {
  const copy = clone(page());
  copy.id = newId();
  copy.elements.forEach((el) => { el.id = newId(); });
  state.design.pages.splice(state.pageIndex + 1, 0, copy);
  state.pageIndex += 1;
  state.selection = [];
}));
$("del-page").addEventListener("click", () => {
  if (state.design.pages.length < 2) return;
  if (page().elements.length && !confirm(`¿Eliminar la página ${state.pageIndex + 1}?`)) return;
  change(() => {
    state.design.pages.splice(state.pageIndex, 1);
    state.pageIndex = Math.max(0, state.pageIndex - 1);
    state.selection = [];
  });
});

// =====================================================================
// exportar
// =====================================================================
function exportDialog() {
  commitTextEdit();
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Descargar">
    <h2>Descargar</h2>
    <div class="row"><b style="width:80px">Formato</b><div class="choice" data-k="format">
      <button data-v="png" aria-pressed="true">PNG</button><button data-v="jpg" aria-pressed="false">JPG</button><button data-v="pdf" aria-pressed="false">PDF</button><button data-v="video" aria-pressed="false">Video (${(videoFormat() || { ext: "no disponible" }).ext.toUpperCase()})</button></div></div>
    <div class="row"><b style="width:80px">Páginas</b><div class="choice" data-k="pages">
      <button data-v="all" aria-pressed="true">Todas (${state.design.pages.length})</button><button data-v="current" aria-pressed="false">Solo la página ${state.pageIndex + 1}</button></div></div>
    <div class="row"><b style="width:80px">Tamaño</b><div class="choice" data-k="scale">
      <button data-v="1" aria-pressed="true">1× (${state.design.width} × ${state.design.height})</button><button data-v="2" aria-pressed="false">2×</button></div></div>
    <p class="muted small" id="export-note"></p>
    <div class="actions"><button class="btn" data-a="cancel">Cancelar</button><button class="btn primary" data-a="go">Descargar</button></div>
  </div>`;
  const values = { format: "png", pages: "all", scale: "1" };
  const note = () => {
    const many = values.pages === "all" && state.design.pages.length > 1;
    const pages = values.pages === "all" ? state.design.pages : [page()];
    const seconds = pages.reduce((sum, p) => sum + (p.duration || PAGE_DURATION), 0);
    back.querySelector("#export-note").textContent = values.format === "video"
      ? `Video con animaciones y videos, sin sonido, hasta 1920 px. Se graba en tiempo real: tarda ${Math.round(seconds)} s (la duración de cada página se cambia en «Animar»).`
      : values.format === "pdf"
        ? "Un PDF con las páginas elegidas."
        : many ? "Varias páginas en imagen se descargan como un .zip con una imagen por página." : "Una imagen de la página.";
  };
  back.querySelectorAll(".choice").forEach((group) => {
    group.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      values[group.dataset.k] = b.dataset.v;
      note();
    }));
  });
  const largest = Math.max(state.design.width, state.design.height);
  if (largest * 2 > 16000) back.querySelector('[data-k="scale"] [data-v="2"]').disabled = true;
  if (!videoFormat()) back.querySelector('[data-k="format"] [data-v="video"]').disabled = true;
  note();
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  back.querySelector('[data-a="cancel"]').addEventListener("click", () => back.remove());
  back.querySelector('[data-a="go"]').addEventListener("click", () => run(async () => {
    back.remove();
    await exportDesign(values.format, values.pages === "all", Number(values.scale));
  }));
  document.body.appendChild(back);
  back.querySelector('[data-a="go"]').focus();
}

async function exportVideo(allPages) {
  const design = clone(state.design);
  const pages = allPages ? design.pages : [design.pages[state.pageIndex]];
  const format = videoFormat();
  let ruta = null;
  if (isDesktop()) {
    ruta = await window.pywebview.api.elegir_destino(safeName(design.title), format.ext);
    if (!ruta) return;
  }
  allVideos().forEach((v) => v.pause());
  let cancelled = false;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal progress-modal" role="dialog" aria-modal="true" aria-label="Grabando video">
    <h2>Grabando el video…</h2><p class="muted small">Se graba en tiempo real; no cierres la ventana.</p>
    <div class="bar"><div></div></div><div class="actions"><button class="btn">Cancelar</button></div></div>`;
  back.querySelector("button").addEventListener("click", () => { cancelled = true; });
  document.body.appendChild(back);
  const fill = back.querySelector(".bar div");
  let result;
  try {
    result = await recordVideo(design, pages, { onProgress: (f) => { fill.style.width = `${Math.round(f * 100)}%`; }, cancelled: () => cancelled });
  } finally {
    back.remove();
  }
  if (!result) { toast("Grabación cancelada."); return; }
  if (ruta) {
    if (!ruta.toLowerCase().endsWith(`.${result.ext}`)) ruta += `.${result.ext}`;
    const saved = await api.saveFile(result.blob, ruta);
    toast(`Guardado: ${saved.nombre}`);
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(result.blob);
    a.download = `${safeName(design.title)}.${result.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Video listo.");
  }
}

async function exportDesign(format, allPages, scale) {
  if (format === "video") { await exportVideo(allPages); return; }
  const design = clone(state.design);
  const pages = allPages ? design.pages : [design.pages[state.pageIndex]];
  setStatus("Preparando la descarga…");
  await loadDesignImages(design);
  const data = pages.map((p) => renderPage(design, p, design.width * scale).toDataURL("image/png"));
  const ext = format === "pdf" ? "pdf" : pages.length > 1 ? "zip" : format;
  let ruta = null;
  if (isDesktop()) {
    ruta = await window.pywebview.api.elegir_destino(safeName(design.title), ext);
    if (!ruta) { setStatus("Guardado"); return; }
  }
  const body = { formato: format, paginas: data, titulo: design.title, diseno: design.id, escala: scale, ruta };
  if (ruta) {
    const result = await api.exportFile(body);
    toast(`Guardado: ${result.nombre}`);
  } else {
    const response = await api.exportFile(body);
    const blob = await response.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName(design.title)}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Descarga lista.");
  }
  setStatus("Guardado");
}

const safeName = (title) => title.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "").trim() || "diseño";

// =====================================================================
// teclado
// =====================================================================
// El panel de atajos (UI6): ? o Ctrl+/ o el botón "?" de la barra superior.
function shortcutsDialog() {
  if (document.querySelector(".modal-back.shortcuts")) return;
  const back = document.createElement("div");
  back.className = "modal-back shortcuts";
  const box = document.createElement("div");
  box.className = "modal wide";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "shortcuts-title");
  const h = document.createElement("h2");
  h.id = "shortcuts-title";
  h.textContent = "Atajos de teclado";
  const table = document.createElement("table");
  table.className = "shortcuts";
  for (const [keys, action] of SHORTCUTS) {
    const row = table.insertRow();
    const k = row.insertCell();
    for (const [i, part] of keys.split(" / ").entries()) {
      if (i) k.append(" / ");
      const kbd = document.createElement("kbd");
      kbd.textContent = part;
      k.append(kbd);
    }
    row.insertCell().textContent = action;
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const close = button("Cerrar", "Cerrar los atajos", () => back.remove());
  close.classList.add("primary");
  actions.append(close);
  box.append(h, table, actions);
  back.append(box);
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); back.remove(); } });
  document.body.append(back);
  close.focus();
}
const isTyping = (target) => target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);

document.addEventListener("keydown", (e) => {
  if (e.key === " " && !isTyping(e.target)) {
    if (!state.spaceDown) { state.spaceDown = true; canvas.style.cursor = "grab"; }
    e.preventDefault();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); run(saveNow); return; }
  if ((mod && e.key === "/") || (e.key === "?" && !isTyping(e.target))) { e.preventDefault(); shortcutsDialog(); return; }
  if (e.key === "Escape" && state.drawMode && !isTyping(e.target)) { e.preventDefault(); setDrawMode(false); return; }
  if (isTyping(e.target)) return;
  const k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && k === "y") { e.preventDefault(); redo(); }
  else if (mod && k === "d") { e.preventDefault(); duplicateSelection(); }
  else if (mod && k === "c") { copySelection(); }
  else if (mod && k === "x") { copySelection(); deleteSelection(); }
  else if (mod && k === "v") { clearTimeout(pasteTimer); pasteTimer = setTimeout(pasteClipboard, 60); }
  else if (mod && k === "a") { e.preventDefault(); state.selection = page().elements.map((el) => el.id); refresh(); }
  else if (mod && k === "g") { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); }
  else if (mod && (k === "b" || k === "i" || k === "u")) {
    const field = { b: "bold", i: "italic", u: "underline" }[k];
    const texts = selected().filter((el) => el.type === "text");
    if (texts.length) { e.preventDefault(); change(() => { const v = !texts[0][field]; texts.forEach((el) => { el[field] = v; fitTextHeight(el); }); }); }
  }
  else if (mod && (k === "=" || k === "+")) { e.preventDefault(); setZoom(state.zoom * 1.2); }
  else if (mod && k === "-") { e.preventDefault(); setZoom(state.zoom / 1.2); }
  else if (mod && k === "0") { e.preventDefault(); fit(); }
  else if (mod && k === "]") { e.preventDefault(); arrange(e.altKey ? "front" : "forward"); }
  else if (mod && k === "[") { e.preventDefault(); arrange(e.altKey ? "back" : "backward"); }
  else if (!mod && e.shiftKey && k === "r") { e.preventDefault(); toggleRulers(); }
  else if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSelection(); }
  else if (k === "escape") { closeMenus(); state.selection = []; refresh(); }
  else if (k === "enter" && selected().length === 1 && selected()[0].type === "text") { e.preventDefault(); startTextEdit(selected()[0]); }
  else if (k === "enter" && selected().length === 1 && selected()[0].type === "table") { e.preventDefault(); startCellEdit(selected()[0], state.activeCell || { r: 0, c: 0 }); }
  else if (k.startsWith("arrow")) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    nudge(k === "arrowleft" ? -step : k === "arrowright" ? step : 0, k === "arrowup" ? -step : k === "arrowdown" ? step : 0);
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === " ") { state.spaceDown = false; canvas.style.cursor = "default"; }
});

// =====================================================================
// todo junto
// =====================================================================
function refresh() {
  render();
  renderCtxbar();
  $("undo").disabled = !history.canUndo;
  $("redo").disabled = !history.canRedo;
  if (document.activeElement !== $("title")) $("title").value = state.design.title;
  if (["layers", "background", "animate"].includes(state.panel)) renderPanel();
  if (state.panel === "ai" && !state.busy && panelSelectionKey() !== lastPanelKey) renderPanel();
  lastPanelKey = panelSelectionKey();
  document.querySelectorAll(".page-thumb").forEach((t, i) => t.classList.toggle("active", i === state.pageIndex));
}

let lastPanelKey = "";
const panelSelectionKey = () => selected().map((el) => `${el.id}:${el.type}`).join(",");

function wire() {
  $("home").innerHTML = ICONS.home;
  $("undo").innerHTML = ICONS.undo;
  $("redo").innerHTML = ICONS.redo;
  $("dup-page").innerHTML = ICONS.copy;
  $("del-page").innerHTML = ICONS.trash;
  $("fit").innerHTML = ICONS.fit;
  $("export").innerHTML = `${ICONS.download}<span>Descargar</span>`;
  const railIcons = {
    templates: "templates", elements: "elements", text: "text", photos: "photos", uploads: "uploads", background: "background",
    ai: "ai", animate: "animate", layers: "layers", brand: "brand",
  };
  $("play").innerHTML = `${ICONS.play}<span>Reproducir</span>`;
  $("play").addEventListener("click", () => run(playDesign));
  document.querySelectorAll(".rail button").forEach((b) => {
    const label = b.textContent;
    b.innerHTML = `${ICONS[railIcons[b.dataset.panel]]}<span>${label}</span>`;
    b.addEventListener("click", () => setPanel(b.dataset.panel));
  });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("home").addEventListener("click", () => run(async () => {
    commitTextEdit();
    if (saveTimer) await saveNow();
    await saving;
    location.href = "/";
  }));
  $("export").addEventListener("click", exportDialog);
  $("shortcuts").addEventListener("click", shortcutsDialog);
  $("size").addEventListener("click", () => { state.focusResize = true; setPanel("templates", false); });
  $("fit").addEventListener("click", fit);
  $("zoom").addEventListener("input", (e) => setZoom(Number(e.target.value) / 100));
  $("title").addEventListener("change", (e) => change(() => { state.design.title = e.target.value.trim() || "Diseño sin título"; }));
  $("title").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  new ResizeObserver(resizeCanvas).observe(viewport);
  window.addEventListener("pagehide", () => {
    const pending = hasPendingSave({
      timerPending: saveTimer !== null,
      requestsPending: pendingSaveRequests,
      revision: saveRevision,
      savedRevision,
    });
    if (pending && state.design) {
      persistOutbox(state.design, saveRevision, serverUpdated).catch(() => {});
      queuePagehideSave({
        design: state.design,
        pending: true,
        accessToken: token(),
        expectedUpdated: serverUpdated,
      });
    }
  });
}

(async function start() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) { location.href = "/"; return; }
  wire();
  let recovery = { design: null, updated: 0, conflicts: 0, failures: 0 };
  try {
    const [design, assets, fonts] = await Promise.all([api.design(id), api.assets(), api.fonts()]);
    state.design = design;
    serverUpdated = design.updated;
    outboxKey = `${id}:${autosaveClientId}:${outboxStage}`;
    recovery.updated = design.updated;
    try {
      recovery = await retryPendingSaves({
        entries: await autosaveOutbox.list(id),
        updated: design.updated,
        save: (draft, expectedUpdated) => api.saveDesign(draft, undefined, expectedUpdated),
        remove: (key, revision) => autosaveOutbox.remove(key, revision),
      });
    } catch {
      recovery.failures += 1;
    }
    if (recovery.design) {
      state.design = { ...recovery.design, updated: recovery.updated };
      serverUpdated = recovery.updated;
    }
    state.assets = assets;
    state.fonts = fonts.instaladas;
    state.catalog = fonts.catalogo;
    await registerFonts(state.fonts);
  } catch (e) {
    document.body.innerHTML = `<div class="empty" style="margin:40px">No se pudo abrir el diseño: ${e.message}. <a href="/">Volver al inicio</a></div>`;
    return;
  }
  document.title = `${state.design.title} · Lienzo`;
  for (const p of state.design.pages) p.elements.forEach(fitTextHeight);
  $("size").textContent = `${state.design.width} × ${state.design.height} px`;
  resizeCanvas();
  fit();
  setPanel("templates", false);
  // UI2: en un teléfono el panel es una hoja sobre el lienzo; se empieza viendo el diseño.
  if (window.matchMedia("(max-width: 720px)").matches) setPanel("templates", true);
  renderPages();
  refresh();
  setStatus(recovery.conflicts ? "Copia local en conflicto" : recovery.failures ? "Copia local pendiente" : "Guardado");
  if (recovery.conflicts) toast("Hay cambios pendientes de otra pestaña. Tu copia permanece en este navegador.");
  else if (recovery.failures) toast("Quedó una copia pendiente; Lienzo volverá a intentarlo al abrir este diseño.");
  await loadDesignImages(state.design);
  render();
  renderPages();
})();
