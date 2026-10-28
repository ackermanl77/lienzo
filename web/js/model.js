// Lienzo: el modelo del diseño en la página (sin DOM, se prueba con Node).
// Misma forma que app/model.py: páginas con fondo y elementos rect / shape /
// text / table / graphic que comparten left, top, width, height, rotation,
// transparency y locked; además group (agrupados) y animation (de entrada).

export const FONTS = [
  "Arial", "Georgia", "Times New Roman", "Verdana", "Trebuchet MS", "Segoe UI", "Bahnschrift",
  "Impact", "Courier New", "Comic Sans MS", "Segoe Script", "Palatino Linotype", "Tahoma", "Cambria",
];

export const SHAPES = [
  { kind: "rect", label: "Rectángulo" },
  { kind: "rounded", label: "Rectángulo redondeado" },
  { kind: "ellipse", label: "Círculo" },
  { kind: "triangle", label: "Triángulo" },
  { kind: "diamond", label: "Rombo" },
  { kind: "hexagon", label: "Hexágono" },
  { kind: "star", label: "Estrella" },
  { kind: "heart", label: "Corazón" },
  { kind: "arrow", label: "Flecha" },
  { kind: "line", label: "Línea" },
];

export const PALETTE = [
  "#000000", "#545454", "#737373", "#a6a6a6", "#d9d9d9", "#ffffff",
  "#ff3131", "#ff5757", "#ff66c4", "#cb6ce6", "#8c52ff", "#5e17eb",
  "#03989e", "#00c2cb", "#5ce1e6", "#38b6ff", "#5170ff", "#004aad",
  "#00bf63", "#7ed957", "#c1ff72", "#ffde59", "#ffbd59", "#ff914d",
  "#1d3557", "#457b9d", "#a8dadc", "#f1faee", "#e63946", "#fde2e4",
];

export const clone = (value) => JSON.parse(JSON.stringify(value));

export function newId(length = 8) {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// ---------------- geometría ----------------
export const center = (el) => ({ x: el.left + el.width / 2, y: el.top + el.height / 2 });

export function rotate(point, origin, degrees) {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = point.x - origin.x, dy = point.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/** El punto en las coordenadas propias del elemento (0..width, 0..height). */
export function toLocal(el, point) {
  const c = center(el);
  const p = rotate(point, c, -(el.rotation || 0));
  return { x: p.x - el.left, y: p.y - el.top };
}

export function corners(el) {
  const c = center(el);
  return [
    { x: el.left, y: el.top }, { x: el.left + el.width, y: el.top },
    { x: el.left + el.width, y: el.top + el.height }, { x: el.left, y: el.top + el.height },
  ].map((p) => rotate(p, c, el.rotation || 0));
}

/** Caja alineada a los ejes que contiene al elemento girado. */
export function bounds(el) {
  const pts = corners(el);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function unionBounds(elements) {
  if (!elements.length) return null;
  const boxes = elements.map(bounds);
  const left = Math.min(...boxes.map((b) => b.left)), top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

export function hitTest(el, point, tolerance = 0) {
  const p = toLocal(el, point);
  return p.x >= -tolerance && p.y >= -tolerance && p.x <= el.width + tolerance && p.y <= el.height + tolerance;
}

/** El elemento de más arriba bajo el punto (los de arriba están al final de la lista). */
export function elementAt(page, point, tolerance = 0) {
  for (let i = page.elements.length - 1; i >= 0; i--) {
    if (hitTest(page.elements[i], point, tolerance)) return page.elements[i];
  }
  return null;
}

export function intersects(a, b) {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Nuevo cuadro al arrastrar un tirador ("nw","n","ne","e","se","s","sw","w"):
 * el lado o la esquina opuestos quedan fijos aunque el elemento esté girado.
 */
export function resizeBox(start, handle, point, keepAspect = false, minSize = 4) {
  const c = center(start);
  const local = rotate(point, c, -(start.rotation || 0));
  const lx = local.x - c.x, ly = local.y - c.y;
  const hw = start.width / 2, hh = start.height / 2;
  let width = start.width, height = start.height;
  if (handle.includes("e")) width = lx + hw;
  if (handle.includes("w")) width = hw - lx;
  if (handle.includes("s")) height = ly + hh;
  if (handle.includes("n")) height = hh - ly;
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);
  if (keepAspect && handle.length === 2) {
    const ratio = start.width / start.height;
    if (width / start.width > height / start.height) height = width / ratio;
    else width = height * ratio;
  }
  let cx = 0, cy = 0;
  if (handle.includes("e")) cx = -hw + width / 2;
  if (handle.includes("w")) cx = hw - width / 2;
  if (handle.includes("s")) cy = -hh + height / 2;
  if (handle.includes("n")) cy = hh - height / 2;
  const world = rotate({ x: c.x + cx, y: c.y + cy }, c, start.rotation || 0);
  return { left: world.x - width / 2, top: world.y - height / 2, width, height };
}

/** Ángulo para el tirador de giro (arriba = 0°); se pega a múltiplos de 45° cerca de ellos. */
export function rotationFromPointer(el, point, free = false) {
  const c = center(el);
  let angle = (Math.atan2(point.y - c.y, point.x - c.x) * 180) / Math.PI + 90;
  angle = ((angle % 360) + 360) % 360;
  if (angle > 180) angle -= 360;
  if (!free) {
    const nearest = Math.round(angle / 45) * 45;
    if (Math.abs(nearest - angle) < 4) angle = nearest;
  }
  return Math.round(angle * 10) / 10;
}

/**
 * Guías inteligentes: mueve `box` (caja alineada) para que su borde o centro
 * coincida con la página u otras cajas si está a menos de `threshold`.
 */
export function snap(box, targets, page, threshold) {
  const xs = [0, page.width / 2, page.width], ys = [0, page.height / 2, page.height];
  for (const t of targets) {
    xs.push(t.left, t.left + t.width / 2, t.left + t.width);
    ys.push(t.top, t.top + t.height / 2, t.top + t.height);
  }
  const best = (edges, lines) => {
    let found = null;
    for (const edge of edges) {
      for (const line of lines) {
        const diff = line - edge;
        if (Math.abs(diff) <= threshold && (!found || Math.abs(diff) < Math.abs(found.diff))) found = { diff, line };
      }
    }
    return found;
  };
  const bx = best([box.left, box.left + box.width / 2, box.left + box.width], xs);
  const by = best([box.top, box.top + box.height / 2, box.top + box.height], ys);
  const guides = [];
  if (bx) guides.push({ axis: "x", pos: bx.line });
  if (by) guides.push({ axis: "y", pos: by.line });
  return { dx: bx ? bx.diff : 0, dy: by ? by.diff : 0, guides };
}

// ---------------- texto ----------------
export function fontString(el, size = el.fontSize) {
  return `${el.italic ? "italic " : ""}${el.bold ? "700" : "400"} ${size}px "${el.fontFamily}", sans-serif`;
}

/** Corta el texto en líneas que caben en `maxWidth`; `measure(str)` da el ancho. */
export function wrapText(text, maxWidth, measure) {
  // una palabra más larga que la caja se parte por letras
  const breakLong = (word) => {
    const pieces = [];
    let rest = word;
    while (rest.length > 1 && measure(rest) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    pieces.push(rest);
    return pieces;
  };
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const token of paragraph.split(/( +)/).filter(Boolean)) {
      if (token.trim() === "") {
        line += token;
        continue;
      }
      const candidate = line + token;
      if (measure(candidate.trimEnd()) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      const pieces = breakLong(token);
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1];
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export const textHeight = (el, lineCount) => Math.max(1, lineCount) * el.fontSize * el.lineHeight;

// ---------------- elementos nuevos ----------------
const base = (fields) => ({ id: newId(), rotation: 0, transparency: 0, locked: false, ...fields });

export function makeText(kind, design) {
  const s = Math.min(design.width, design.height);
  const presets = {
    heading: { text: "Agrega un título", size: 0.09, bold: true },
    subheading: { text: "Agrega un subtítulo", size: 0.055, bold: true },
    body: { text: "Agrega un poco de texto", size: 0.035, bold: false },
  };
  const p = presets[kind] || presets.body;
  const fontSize = Math.max(8, Math.round(s * p.size));
  const width = Math.min(design.width * 0.8, fontSize * p.text.length * 0.62);
  return base({
    type: "text", text: p.text, fontFamily: "Arial", fontSize, bold: p.bold, italic: false, underline: false,
    color: "#1f2933", align: "center", lineHeight: 1.2, width, height: fontSize * 1.2,
    left: (design.width - width) / 2, top: (design.height - fontSize * 1.2) / 2,
  });
}

export function makeShape(kind, design) {
  const s = Math.min(design.width, design.height) * 0.3;
  const box = { width: s, height: s, left: (design.width - s) / 2, top: (design.height - s) / 2 };
  const stroke = { color: "#1f2933", width: 0 };
  if (kind === "rect" || kind === "rounded") {
    return base({ type: "rect", ...box, fill: { color: "#8c52ff" }, radius: kind === "rounded" ? s * 0.15 : 0, stroke });
  }
  if (kind === "line" || kind === "arrow") {
    const width = Math.min(design.width, design.height) * 0.4;
    const height = kind === "line" ? Math.max(4, width * 0.02) : width * 0.25;
    return base({
      type: "shape", kind, width, height, left: (design.width - width) / 2, top: (design.height - height) / 2,
      fill: { color: "#1f2933" }, stroke,
    });
  }
  return base({ type: "shape", kind, ...box, fill: { color: "#8c52ff" }, stroke });
}

/** Una imagen subida como rectángulo con relleno de imagen, como en Canva. */
export function makeImage(asset, design, at = null) {
  const scale = Math.min((design.width * 0.6) / asset.width, (design.height * 0.6) / asset.height, 1);
  const width = Math.max(8, asset.width * scale), height = Math.max(8, asset.height * scale);
  const cx = at ? at.x : design.width / 2, cy = at ? at.y : design.height / 2;
  return base({
    type: "rect", left: cx - width / 2, top: cy - height / 2, width, height,
    fill: { color: "", image: asset.id }, radius: 0, stroke: { color: "#1f2933", width: 0 },
  });
}

export const newPage = () => ({ id: newId(), background: { color: "#ffffff" }, elements: [] });

export function describe(el) {
  if (el.type === "draw") return "Dibujo";
  if (el.type === "text") return el.text.split("\n")[0].slice(0, 28) || "Texto";
  if (el.type === "table") return `Tabla ${el.rows} × ${el.cols}`;
  if (el.type === "graphic") return `Gráfico: ${el.name}`;
  if (el.type === "rect" && el.fill && el.fill.video) return "Video";
  if (el.type === "rect") return el.fill && el.fill.image ? "Imagen" : el.radius ? "Rectángulo redondeado" : "Rectángulo";
  const shape = SHAPES.find((s) => s.kind === el.kind);
  return shape ? shape.label : "Forma";
}

export const MAX_DRAW_POINTS = 2000;

/**
 * Un trazo a mano alzada (UI4) como elemento "draw": su caja rodea los puntos (más medio grosor),
 * y los puntos se guardan como fracciones de esa caja, así que moverlo, escalarlo, girarlo o
 * cambiar el tamaño del diseño funcionan como con cualquier otro elemento. Los puntos casi
 * repetidos se descartan; null si el trazo no tiene al menos dos puntos distintos.
 */
export function makeDrawing(points, color, width) {
  const kept = [];
  const minStep = Math.max(0.5, width * 0.15);
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minStep) kept.push(p);
  }
  if (kept.length < 2) return null;
  const step = Math.ceil(kept.length / MAX_DRAW_POINTS);
  const pts = step > 1 ? kept.filter((_, i) => i % step === 0 || i === kept.length - 1) : kept;
  const pad = width / 2;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const left = Math.min(...xs) - pad, top = Math.min(...ys) - pad;
  const w = Math.max(1, Math.max(...xs) + pad - left), h = Math.max(1, Math.max(...ys) + pad - top);
  return base({
    type: "draw", left, top, width: w, height: h,
    points: pts.map((p) => [(p.x - left) / w, (p.y - top) / h]),
    stroke: { color, width },
  });
}

/** Un elemento copiado con id nuevo y un pequeño desplazamiento. */
export function duplicateElement(el, offset) {
  return { ...clone(el), id: newId(), left: el.left + offset, top: el.top + offset };
}

// ---------------- historial (deshacer / rehacer) ----------------
export class History {
  constructor(limit = 100) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }
  /** Guarda el estado anterior a un cambio. */
  record(snapshot) {
    if (this.past[this.past.length - 1] === snapshot) return;
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(current);
    return this.past.pop();
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(current);
    return this.future.pop();
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}


// ---------------- animaciones de entrada ----------------
export const ANIMATIONS = [
  { type: "none", label: "Ninguna" },
  { type: "fade", label: "Aparecer" },
  { type: "rise", label: "Subir" },
  { type: "slide_left", label: "Deslizar ←" },
  { type: "slide_right", label: "Deslizar →" },
  { type: "pop", label: "Rebotar" },
  { type: "zoom_out", label: "Acercar" },
  { type: "drop", label: "Caer" },
  { type: "spin", label: "Girar" },
  { type: "typewriter", label: "Máquina de escribir" },
];
export const PAGE_DURATION = 5;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeBack = (p) => { const c = 1.70158; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; };
function easeBounce(p) {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
}

/**
 * Estado de la animación de entrada de `el` en el segundo `t` de su página.
 * Sin animación (o t == null) devuelve el estado final.
 */
export function animState(el, t) {
  const done = { alpha: 1, dx: 0, dy: 0, scale: 1, rotate: 0, text: 1 };
  const a = el.animation;
  if (t == null || !a || a.type === "none") return done;
  const p = clamp01((t - (a.delay || 0)) / Math.max(0.01, a.duration || 0.8));
  const e = easeOut(p);
  const travel = (size) => Math.max(60, size * 0.6);
  switch (a.type) {
    case "fade": return { ...done, alpha: e };
    case "rise": return { ...done, alpha: e, dy: (1 - e) * travel(el.height) };
    case "slide_left": return { ...done, alpha: e, dx: (1 - e) * travel(el.width) };
    case "slide_right": return { ...done, alpha: e, dx: -(1 - e) * travel(el.width) };
    case "pop": return { ...done, alpha: clamp01(p * 3), scale: p === 0 ? 0 : easeBack(p) };
    case "zoom_out": return { ...done, alpha: e, scale: 1 + (1 - e) * 0.6 };
    case "drop": return { ...done, alpha: clamp01(p * 4), dy: -(1 - easeBounce(p)) * travel(el.height) };
    case "spin": return { ...done, alpha: e, scale: 0.3 + 0.7 * e, rotate: (1 - e) * -180 };
    case "typewriter":
      return el.type === "text" || el.type === "table" ? { ...done, alpha: p > 0 ? 1 : 0, text: p } : { ...done, alpha: e };
    default: return done;
  }
}

/** Segundo en que termina la última animación de la página. */
export function animationsEnd(page) {
  return Math.max(0, ...page.elements.map((el) => (el.animation && el.animation.type !== "none"
    ? (el.animation.delay || 0) + (el.animation.duration || 0.8) : 0)));
}

// ---------------- tablas ----------------
export function makeTable(design, rows = 4, cols = 3) {
  const s = Math.min(design.width, design.height);
  const width = design.width * 0.8;
  const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 0 ? `Título ${c + 1}` : "")));
  return base({
    type: "table", rows, cols, cells, colWidths: Array(cols).fill(1 / cols), fontFamily: "Arial",
    fontSize: Math.max(8, Math.round(s * 0.028)), color: "#1f2933", align: "left", header: true, headerFill: "#6c3cf0",
    headerColor: "#ffffff", cellFill: "#ffffff", stripe: true, borderColor: "#d9d6e8", borderWidth: Math.max(1, Math.round(s * 0.002)),
    lineHeight: 1.25, width, height: 100, left: (design.width - width) / 2, top: design.height * 0.3,
  });
}

/**
 * Posiciones de filas y columnas de una tabla; la altura de cada fila se ajusta
 * a su texto. `measure(text, bold)` da el ancho del texto en la fuente de la tabla.
 */
export function tableLayout(el, measure) {
  const pad = el.fontSize * 0.45;
  const lineH = el.fontSize * el.lineHeight;
  const colW = el.colWidths.map((f) => f * el.width);
  const colX = [];
  let x = 0;
  for (const w of colW) { colX.push(x); x += w; }
  const lines = el.cells.map((row, r) => row.map((text, c) => {
    const bold = el.header && r === 0;
    return wrapText(text, Math.max(1, colW[c] - pad * 2), (s) => measure(s, bold));
  }));
  const rowH = lines.map((row) => Math.max(1, ...row.map((l) => l.length)) * lineH + pad * 2);
  const rowY = [];
  let y = 0;
  for (const h of rowH) { rowY.push(y); y += h; }
  return { pad, lineH, colX, colW, rowY, rowH, lines, height: y };
}

/** La celda bajo un punto local (0..width, 0..height), o null. */
export function cellAt(layout, local) {
  const c = layout.colX.findIndex((x, i) => local.x >= x && local.x < x + layout.colW[i]);
  const r = layout.rowY.findIndex((y, i) => local.y >= y && local.y < y + layout.rowH[i]);
  return r < 0 || c < 0 ? null : { r, c };
}

export function tableInsertRow(el, at) {
  el.cells.splice(at, 0, Array(el.cols).fill(""));
  el.rows = el.cells.length;
}

export function tableRemoveRow(el, at) {
  if (el.rows <= 1) return;
  el.cells.splice(at, 1);
  el.rows = el.cells.length;
}

export function tableInsertCol(el, at) {
  el.cells.forEach((row) => row.splice(at, 0, ""));
  el.colWidths.splice(at, 0, 1 / el.cols);
  el.cols += 1;
  const total = el.colWidths.reduce((a, b) => a + b, 0);
  el.colWidths = el.colWidths.map((w) => w / total);
}

export function tableRemoveCol(el, at) {
  if (el.cols <= 1) return;
  el.cells.forEach((row) => row.splice(at, 1));
  el.colWidths.splice(at, 1);
  el.cols -= 1;
  const total = el.colWidths.reduce((a, b) => a + b, 0);
  el.colWidths = el.colWidths.map((w) => w / total);
}

// ---------------- gráficos de la galería ----------------
export function makeGraphic(name, design, color = "#6c3cf0") {
  const s = Math.min(design.width, design.height) * 0.28;
  return base({ type: "graphic", name, fill: { color }, width: s, height: s, left: (design.width - s) / 2, top: (design.height - s) / 2 });
}

/** Un video subido como rectángulo con relleno de video. */
export function makeVideo(asset, design) {
  const el = makeImage(asset, design);
  el.fill = { color: "", video: asset.id };
  return el;
}

// ---------------- grupos ----------------
/** Los ids seleccionados más todos los elementos de sus grupos. */
export function expandGroups(page, ids) {
  const groups = new Set(page.elements.filter((el) => ids.includes(el.id) && el.group).map((el) => el.group));
  return page.elements.filter((el) => ids.includes(el.id) || (el.group && groups.has(el.group))).map((el) => el.id);
}

/** Escala elementos (copias de su estado inicial) de la caja `from` a la caja `to`, de forma uniforme. */
export function scaleElements(starts, from, to) {
  const s = to.width / from.width;
  return starts.map((st) => {
    const c = center(st);
    const width = st.width * s, height = st.height * s;
    const out = {
      id: st.id, width, height,
      left: to.left + (c.x - from.left) * s - width / 2,
      top: to.top + (c.y - from.top) * s - height / 2,
    };
    if (st.fontSize) out.fontSize = st.fontSize * s;
    if (st.radius) out.radius = st.radius * s;
    if (st.stroke) out.stroke = { ...st.stroke, width: st.stroke.width * s };
    if (st.borderWidth) out.borderWidth = st.borderWidth * s;
    return out;
  });
}

/** Si `el` cubre (casi) toda la página: un fondo o una foto a sangre, sin girar. */
function coversPage(el, width, height) {
  const tol = 0.01;
  return !el.rotation && el.left <= width * tol && el.top <= height * tol
    && el.left + el.width >= width * (1 - tol) && el.top + el.height >= height * (1 - tol);
}

/**
 * Una copia de `design` en otro tamaño ("Cambiar tamaño", UI3). El centro de cada elemento se
 * mueve en proporción a la página, y el elemento se escala de forma uniforme por el menor de los
 * dos factores, para que nada se deforme ni se salga; lo que cubría toda la página (un fondo, una
 * foto a sangre) se escala por el mayor, para que la siga cubriendo.
 */
export function resizeDesign(design, width, height) {
  const sx = width / design.width, sy = height / design.height;
  const unit = { left: 0, top: 0, width: 1, height: 1 };
  const copy = clone(design);
  copy.width = width;
  copy.height = height;
  for (const page of copy.pages) {
    page.elements = page.elements.map((el) => {
      const k = coversPage(el, design.width, design.height) ? Math.max(sx, sy) : Math.min(sx, sy);
      const [scaled] = scaleElements([el], unit, { ...unit, width: k });
      const c = center(el);
      return { ...el, ...scaled, left: c.x * sx - scaled.width / 2, top: c.y * sy - scaled.height / 2 };
    });
  }
  return copy;
}

/** Gira elementos (copias de su estado inicial) `delta` grados alrededor de `origin`. */
export function rotateElements(starts, origin, delta) {
  return starts.map((st) => {
    const c = rotate(center(st), origin, delta);
    let rotation = ((st.rotation || 0) + delta) % 360;
    if (rotation > 180) rotation -= 360;
    if (rotation < -180) rotation += 360;
    return { id: st.id, left: c.x - st.width / 2, top: c.y - st.height / 2, rotation: Math.round(rotation * 10) / 10 };
  });
}
