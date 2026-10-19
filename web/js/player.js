// Reproducción de un diseño con sus animaciones y videos: la presentación a
// pantalla completa y la grabación a un archivo de video (MediaRecorder sobre
// un <canvas>, en tiempo real; sin sonido).
import { PAGE_DURATION } from "./model.js";
import { drawPage, loadDesignImages, videoFor } from "./render.js";

/** Las páginas en orden con su inicio y duración (segundos). */
export function timeline(pages) {
  let start = 0;
  return pages.map((page) => {
    const item = { page, start, duration: page.duration || PAGE_DURATION };
    start += item.duration;
    return item;
  });
}

export const totalDuration = (pages) => pages.reduce((sum, p) => sum + (p.duration || PAGE_DURATION), 0);

/** Pone los videos de la página en el segundo `t` (y en pausa los demás si `others`). */
function syncVideos(page, t, playing) {
  for (const el of page.elements) {
    if (!el.fill || !el.fill.video) continue;
    const v = videoFor(el.fill.video);
    if (!v || !v.duration) continue;
    const target = t % v.duration;
    if (Math.abs(v.currentTime - target) > 0.35) v.currentTime = target;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }
}

function pageAt(items, t) {
  for (const item of items) if (t < item.start + item.duration) return item;
  return items[items.length - 1];
}

/** Presentación a pantalla completa. Esc cierra; ← → cambian de página; espacio pausa. */
export async function present(design, startIndex = 0) {
  await loadDesignImages(design);
  const items = timeline(design.pages);
  const overlay = document.createElement("div");
  overlay.className = "player";
  overlay.innerHTML = `<canvas></canvas><div class="player-bar"><span class="player-info"></span>
    <div class="player-progress"><div></div></div><button class="btn" data-a="close">Cerrar (Esc)</button></div>`;
  document.body.appendChild(overlay);
  overlay.requestFullscreen?.().catch(() => {});
  const canvas = overlay.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const info = overlay.querySelector(".player-info");
  const bar = overlay.querySelector(".player-progress div");
  let t = items[Math.min(startIndex, items.length - 1)].start;
  let last = performance.now();
  let paused = false;
  let frame = 0;
  let closed = false;

  function draw() {
    const now = performance.now();
    if (!paused) t += (now - last) / 1000;
    last = now;
    const total = totalDuration(design.pages);
    if (t >= total) t = 0;
    const item = pageAt(items, t);
    const local = t - item.start;
    const dpr = window.devicePixelRatio || 1;
    const w = overlay.clientWidth, h = overlay.clientHeight - 48;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.height = `${h}px`;
    }
    const scale = Math.min(w / design.width, h / design.height) * 0.96;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.translate((w - design.width * scale) / 2, (h - design.height * scale) / 2);
    ctx.scale(scale, scale);
    syncVideos(item.page, local, !paused);
    drawPage(ctx, design, item.page, { time: local });
    info.textContent = `Página ${items.indexOf(item) + 1} de ${items.length} · ${local.toFixed(1)} / ${item.duration} s${paused ? " · en pausa" : ""}`;
    bar.style.width = `${(t / total) * 100}%`;
    if (!closed) frame = requestAnimationFrame(draw);
  }

  function close() {
    closed = true;
    cancelAnimationFrame(frame);
    document.removeEventListener("keydown", onKey, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    for (const item of items) syncVideos(item.page, 0, false);
    overlay.remove();
  }

  function onKey(e) {
    e.stopPropagation();
    e.preventDefault();
    const item = pageAt(items, t);
    const i = items.indexOf(item);
    if (e.key === "Escape") close();
    else if (e.key === " ") paused = !paused;
    else if (e.key === "ArrowRight") t = items[Math.min(items.length - 1, i + 1)].start;
    else if (e.key === "ArrowLeft") t = items[Math.max(0, i - 1)].start;
    else if (e.key === "Home") t = 0;
  }
  document.addEventListener("keydown", onKey, true);
  overlay.querySelector('[data-a="close"]').addEventListener("click", close);
  canvas.addEventListener("click", () => { paused = !paused; });
  draw();
}

/** El formato de video que este navegador puede grabar (mp4 si se puede, si no webm). */
export function videoFormat() {
  const options = [
    ["video/mp4;codecs=avc1.42E01E", "mp4"], ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"], ["video/webm;codecs=vp8", "webm"], ["video/webm", "webm"],
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const [mime, ext] of options) if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  return null;
}

/**
 * Graba las páginas a un video en tiempo real. `onProgress(fracción)` informa
 * el avance; `cancelled()` permite detenerlo. Devuelve { blob, ext }.
 */
export async function recordVideo(design, pages, { maxSide = 1920, fps = 30, onProgress = () => {}, cancelled = () => false } = {}) {
  const format = videoFormat();
  if (!format) throw new Error("Este navegador no puede grabar video.");
  await loadDesignImages(design);
  const scale = Math.min(1, maxSide / Math.max(design.width, design.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round((design.width * scale) / 2) * 2);
  canvas.height = Math.max(2, Math.round((design.height * scale) / 2) * 2);
  const ctx = canvas.getContext("2d");
  const items = timeline(pages);
  const total = totalDuration(pages);
  const stream = canvas.captureStream(fps);
  const pixels = canvas.width * canvas.height;
  const recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: Math.min(16e6, Math.max(2e6, pixels * 4)) });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  for (const item of items) syncVideos(item.page, 0, false);

  const drawAt = (t) => {
    const item = pageAt(items, t);
    const local = t - item.start;
    syncVideos(item.page, local, true);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawPage(ctx, design, item.page, { time: local });
  };
  drawAt(0);
  recorder.start(250);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= total || cancelled()) { drawAt(Math.min(t, total - 0.001)); resolve(); return; }
      drawAt(t);
      onProgress(t / total);
      // requestAnimationFrame se frena si la ventana no se ve; setTimeout sigue.
      setTimeout(tick, 1000 / fps);
    };
    tick();
  });
  recorder.stop();
  await stopped;
  for (const item of items) syncVideos(item.page, 0, false);
  if (cancelled()) return null;
  return { blob: new Blob(chunks, { type: format.mime.split(";")[0] }), ext: format.ext };
}
