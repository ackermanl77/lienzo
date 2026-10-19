// Dibuja páginas de un diseño en un <canvas> 2D. Lo usan el editor, las
// miniaturas, la reproducción y la exportación, así lo que se ve es lo que se
// exporta. Con `time` (segundos desde el inicio de la página) se aplican las
// animaciones de entrada.
import { graphicPath } from "./graphics.js";
import { animState, fontString, tableLayout, textHeight, wrapText } from "./model.js";

export const assetUrl = (id) => `/assets/${id}`;

// ---------------- imágenes subidas ----------------
const images = new Map(); // id -> { img, ready, promise }

export function loadImage(id) {
  if (images.has(id)) return images.get(id).promise;
  const entry = { img: new Image(), ready: false };
  entry.promise = new Promise((resolve) => {
    entry.img.onload = () => { entry.ready = true; resolve(entry.img); };
    entry.img.onerror = () => resolve(null);
  });
  entry.img.src = assetUrl(id);
  images.set(id, entry);
  return entry.promise;
}

export function imageFor(id) {
  const entry = images.get(id);
  return entry && entry.ready ? entry.img : null;
}

// ---------------- videos ----------------
const videos = new Map(); // id -> { video, promise }

/** Un <video> silenciado y en bucle por cada video subido (se comparte entre elementos). */
export function loadVideo(id) {
  if (videos.has(id)) return videos.get(id).promise;
  const video = document.createElement("video");
  Object.assign(video, { muted: true, loop: true, playsInline: true, preload: "auto", crossOrigin: "anonymous" });
  const entry = { video };
  entry.promise = new Promise((resolve) => {
    video.addEventListener("loadeddata", () => resolve(video), { once: true });
    video.addEventListener("error", () => resolve(null), { once: true });
  });
  video.src = assetUrl(id);
  videos.set(id, entry);
  return entry.promise;
}

export function videoFor(id) {
  const entry = videos.get(id);
  return entry && entry.video.readyState >= 2 ? entry.video : null;
}

export function allVideos() {
  return [...videos.values()].map((e) => e.video);
}

export const usesVideo = (page) => page.elements.some((el) => el.fill && el.fill.video);

/** Espera a que estén cargadas todas las imágenes y videos que usa el diseño. */
export function loadDesignImages(design) {
  const jobs = [];
  for (const page of design.pages) {
    if (page.background.image) jobs.push(loadImage(page.background.image));
    for (const el of page.elements) {
      if (el.fill && el.fill.image) jobs.push(loadImage(el.fill.image));
      if (el.fill && el.fill.video) jobs.push(loadVideo(el.fill.video));
    }
  }
  return Promise.all(jobs);
}

// ---------------- fuentes descargadas ----------------
const fontsLoaded = new Set();

/** Registra en el documento las fuentes instaladas (`[{family, files:[{url, style, weight}]}]`). */
export async function registerFonts(list) {
  const jobs = [];
  for (const font of list) {
    for (const file of font.files) {
      const key = `${font.family}|${file.url}`;
      if (fontsLoaded.has(key)) continue;
      fontsLoaded.add(key);
      const face = new FontFace(font.family, `url(${file.url})`, { style: file.style, weight: String(file.weight) });
      jobs.push(face.load().then((f) => document.fonts.add(f)).catch(() => fontsLoaded.delete(key)));
    }
  }
  await Promise.all(jobs);
}

// ---------------- texto ----------------
let measureCtx = null;
function measurer(el, bold = el.bold) {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  measureCtx.font = fontString({ ...el, bold });
  return (s) => measureCtx.measureText(s).width;
}

export function layoutText(el) {
  return wrapText(el.text, Math.max(1, el.width), measurer(el));
}

export function layoutTable(el) {
  const normal = measurer(el, false), bold = measurer(el, true);
  return tableLayout(el, (s, isBold) => (isBold ? bold(s) : normal(s)));
}

/** Ajusta la altura de un texto o una tabla a su contenido (como en Canva). */
export function fitTextHeight(el) {
  if (el.type === "text") el.height = textHeight(el, layoutText(el).length);
  else if (el.type === "table") el.height = layoutTable(el).height;
  return el;
}

// ---------------- formas ----------------
function shapePath(ctx, el) {
  const w = el.width, h = el.height;
  ctx.beginPath();
  switch (el.kind) {
    case "ellipse":
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "triangle":
      ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(w / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h / 2); ctx.closePath();
      break;
    case "hexagon":
      ctx.moveTo(w * 0.25, 0); ctx.lineTo(w * 0.75, 0); ctx.lineTo(w, h / 2);
      ctx.lineTo(w * 0.75, h); ctx.lineTo(w * 0.25, h); ctx.lineTo(0, h / 2); ctx.closePath();
      break;
    case "star": {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.4 : 1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = w / 2 + (Math.cos(a) * r * w) / 2, y = h / 2 + (Math.sin(a) * r * h) / 2 + h * 0.05;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      break;
    }
    case "heart":
      ctx.moveTo(w / 2, h * 0.28);
      ctx.bezierCurveTo(w / 2, h * 0.05, w * 0.05, h * -0.02, w * 0.03, h * 0.32);
      ctx.bezierCurveTo(w * 0.02, h * 0.58, w * 0.3, h * 0.75, w / 2, h);
      ctx.bezierCurveTo(w * 0.7, h * 0.75, w * 0.98, h * 0.58, w * 0.97, h * 0.32);
      ctx.bezierCurveTo(w * 0.95, h * -0.02, w / 2, h * 0.05, w / 2, h * 0.28);
      ctx.closePath();
      break;
    case "arrow":
      ctx.moveTo(0, h * 0.35); ctx.lineTo(w * 0.7, h * 0.35); ctx.lineTo(w * 0.7, 0); ctx.lineTo(w, h / 2);
      ctx.lineTo(w * 0.7, h); ctx.lineTo(w * 0.7, h * 0.65); ctx.lineTo(0, h * 0.65); ctx.closePath();
      break;
    case "line":
    default:
      ctx.rect(0, 0, w, h);
  }
}

function roundedRect(ctx, w, h, r) {
  ctx.beginPath();
  if (r > 0 && ctx.roundRect) ctx.roundRect(0, 0, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(0, 0, w, h);
}

/** Dibuja una imagen o un cuadro de video cubriendo la caja (recorta lo que sobra, centrado). */
function drawCover(ctx, media, w, h) {
  const mw = media.naturalWidth || media.videoWidth, mh = media.naturalHeight || media.videoHeight;
  if (!mw || !mh) return;
  const scale = Math.max(w / mw, h / mh);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(media, (mw - sw) / 2, (mh - sh) / 2, sw, sh, 0, 0, w, h);
}

function fillAndStroke(ctx, el) {
  const fill = el.fill || {};
  if (fill.image || fill.video) {
    const media = fill.video ? videoFor(fill.video) : imageFor(fill.image);
    ctx.save();
    ctx.clip();
    if (media) drawCover(ctx, media, el.width, el.height);
    else {
      ctx.fillStyle = "#d9d6e8";
      ctx.fillRect(0, 0, el.width, el.height);
    }
    ctx.restore();
  } else if (fill.color) {
    ctx.fillStyle = fill.color;
    ctx.fill();
  }
  if (el.stroke && el.stroke.width > 0) {
    ctx.lineWidth = el.stroke.width;
    ctx.strokeStyle = el.stroke.color;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

/** Corta las líneas a la fracción `fraction` de sus caracteres (efecto máquina de escribir). */
function typed(lines, fraction) {
  if (fraction >= 1) return lines;
  let budget = Math.floor(lines.join("").length * fraction);
  return lines.map((line) => {
    const part = line.slice(0, Math.max(0, budget));
    budget -= line.length;
    return part;
  });
}

function drawText(ctx, el, fraction = 1) {
  const lines = typed(layoutText(el), fraction);
  ctx.font = fontString(el);
  ctx.fillStyle = el.color;
  ctx.textBaseline = "alphabetic";
  const lineBox = el.fontSize * el.lineHeight;
  const ascent = el.fontSize * 0.8 + (lineBox - el.fontSize) / 2;
  const full = layoutText(el);
  lines.forEach((line, i) => {
    const width = ctx.measureText(full[i]).width;
    const x = el.align === "center" ? (el.width - width) / 2 : el.align === "right" ? el.width - width : 0;
    const y = i * lineBox + ascent;
    ctx.fillText(line, x, y);
    if (el.underline && line) {
      ctx.fillRect(x, y + el.fontSize * 0.1, ctx.measureText(line).width, Math.max(1, el.fontSize * 0.06));
    }
  });
}

function drawTable(ctx, el, fraction = 1) {
  const L = layoutTable(el);
  for (let r = 0; r < el.rows; r++) {
    const header = el.header && r === 0;
    ctx.fillStyle = header ? el.headerFill : el.stripe && r % 2 === 0 ? shade(el.cellFill) : el.cellFill;
    ctx.fillRect(0, L.rowY[r], el.width, L.rowH[r]);
    ctx.font = fontString({ ...el, bold: header });
    ctx.fillStyle = header ? el.headerColor : el.color;
    ctx.textBaseline = "alphabetic";
    for (let c = 0; c < el.cols; c++) {
      const lines = typed(L.lines[r][c], fraction);
      const ascent = el.fontSize * 0.8 + (L.lineH - el.fontSize) / 2;
      lines.forEach((line, i) => {
        const width = ctx.measureText(L.lines[r][c][i]).width;
        const inner = L.colW[c] - L.pad * 2;
        const dx = el.align === "center" ? (inner - width) / 2 : el.align === "right" ? inner - width : 0;
        ctx.fillText(line, L.colX[c] + L.pad + dx, L.rowY[r] + L.pad + i * L.lineH + ascent);
      });
    }
  }
  if (el.borderWidth > 0) {
    ctx.strokeStyle = el.borderColor;
    ctx.lineWidth = el.borderWidth;
    ctx.beginPath();
    for (const y of [...L.rowY, L.height]) { ctx.moveTo(0, y); ctx.lineTo(el.width, y); }
    for (const x of [...L.colX, el.width]) { ctx.moveTo(x, 0); ctx.lineTo(x, L.height); }
    ctx.stroke();
  }
}

/** Un poco más oscuro (filas alternas de las tablas). */
function shade(color) {
  const n = parseInt(color.slice(1), 16);
  const k = 0.94;
  const ch = (v) => Math.round(v * k).toString(16).padStart(2, "0");
  return `#${ch(n >> 16)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

function drawGraphic(ctx, el) {
  const g = graphicPath(el.name);
  if (!g) return;
  ctx.save();
  ctx.scale(el.width / 100, el.height / 100);
  ctx.fillStyle = (el.fill && el.fill.color) || "#6c3cf0";
  ctx.fill(g.path, g.evenodd ? "evenodd" : "nonzero");
  ctx.restore();
}

export function drawElement(ctx, el, time = null) {
  const a = animState(el, time);
  if (a.alpha <= 0) return;
  ctx.save();
  ctx.translate(el.left + el.width / 2 + a.dx, el.top + el.height / 2 + a.dy);
  ctx.rotate((((el.rotation || 0) + a.rotate) * Math.PI) / 180);
  if (a.scale !== 1) ctx.scale(a.scale, a.scale);
  ctx.translate(-el.width / 2, -el.height / 2);
  ctx.globalAlpha = (1 - (el.transparency || 0)) * a.alpha;
  if (el.type === "rect") {
    roundedRect(ctx, el.width, el.height, el.radius || 0);
    fillAndStroke(ctx, el);
  } else if (el.type === "shape") {
    shapePath(ctx, el);
    fillAndStroke(ctx, el);
  } else if (el.type === "text") {
    drawText(ctx, el, a.text);
  } else if (el.type === "table") {
    drawTable(ctx, el, a.text);
  } else if (el.type === "graphic") {
    drawGraphic(ctx, el);
  }
  ctx.restore();
}

/** Dibuja una página completa en (0,0)-(ancho,alto) del sistema actual del contexto. */
export function drawPage(ctx, design, page, { skip = null, time = null } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, design.width, design.height);
  ctx.clip();
  ctx.fillStyle = page.background.color || "#ffffff";
  ctx.fillRect(0, 0, design.width, design.height);
  if (page.background.image) {
    const img = imageFor(page.background.image);
    if (img) drawCover(ctx, img, design.width, design.height);
  }
  for (const el of page.elements) if (el.id !== skip) drawElement(ctx, el, time);
  ctx.restore();
}

/** Una página en un canvas nuevo de `width` px de ancho (miniaturas y exportación). */
export function renderPage(design, page, width) {
  const scale = width / design.width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(design.width * scale));
  canvas.height = Math.max(1, Math.round(design.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  drawPage(ctx, design, page);
  return canvas;
}
