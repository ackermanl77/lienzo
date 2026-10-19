// Galería incorporada de gráficos vectoriales (propios, sin internet). Cada uno
// es un trazado SVG en una caja de 100 × 100 que se escala al tamaño del
// elemento y se rellena con su color; `evenodd` marca los que tienen huecos.

const f = (n) => Math.round(n * 100) / 100;

function polygon(points) {
  return `M${points.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L")} Z`;
}

function starPath(n, inner, rotation = -90, cx = 50, cy = 50, outer = 50) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? outer * inner : outer;
    const a = ((rotation + (i * 180) / n) * Math.PI) / 180;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return polygon(pts);
}

function circle(cx, cy, r) {
  return `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`;
}

function scallop(n, r, bump) {
  let d = "";
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const p0 = [50 + Math.cos(a0) * r, 50 + Math.sin(a0) * r];
    const p1 = [50 + Math.cos(a1) * r, 50 + Math.sin(a1) * r];
    const c = [50 + Math.cos(am) * (r + bump), 50 + Math.sin(am) * (r + bump)];
    d += `${i ? "" : `M${f(p0[0])} ${f(p0[1])} `}Q${f(c[0])} ${f(c[1])} ${f(p1[0])} ${f(p1[1])} `;
  }
  return `${d}Z`;
}

function sun() {
  let d = circle(50, 50, 22);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, w = 0.13;
    d += ` ${polygon([[50 + Math.cos(a - w) * 30, 50 + Math.sin(a - w) * 30], [50 + Math.cos(a) * 50, 50 + Math.sin(a) * 50],
      [50 + Math.cos(a + w) * 30, 50 + Math.sin(a + w) * 30]])}`;
  }
  return d;
}

function thick(points, w) {
  // Una línea quebrada gruesa como polígono (para la palomita, la equis, etc.).
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    left.push([x - dy * w, y + dx * w]);
    right.push([x + dy * w, y - dx * w]);
  }
  return polygon([...left, ...right.reverse()]);
}

export const GRAPHICS = [
  // formas decorativas
  { name: "burst", label: "Explosión", cat: "Formas", path: starPath(16, 0.72) },
  { name: "seal", label: "Sello", cat: "Formas", path: scallop(18, 44, 7) },
  { name: "star-4", label: "Destello", cat: "Formas", path: starPath(4, 0.32) },
  { name: "star-6", label: "Estrella de 6", cat: "Formas", path: starPath(6, 0.55) },
  { name: "star-8", label: "Estrella de 8", cat: "Formas", path: starPath(8, 0.6) },
  { name: "ring", label: "Anillo", cat: "Formas", path: `${circle(50, 50, 50)} ${circle(50, 50, 32)}`, evenodd: true },
  { name: "pentagon", label: "Pentágono", cat: "Formas", path: starPath(5, 0.81, -90) },
  { name: "octagon", label: "Octágono", cat: "Formas", path: starPath(8, 0.924, -67.5) },
  { name: "cross", label: "Cruz", cat: "Formas", path: polygon([[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]]) },
  { name: "chevron", label: "Chevrón", cat: "Formas", path: polygon([[0, 0], [55, 0], [100, 50], [55, 100], [0, 100], [45, 50]]) },
  { name: "parallelogram", label: "Paralelogramo", cat: "Formas", path: polygon([[25, 0], [100, 0], [75, 100], [0, 100]]) },
  { name: "trapezoid", label: "Trapecio", cat: "Formas", path: polygon([[22, 0], [78, 0], [100, 100], [0, 100]]) },
  { name: "blob", label: "Mancha", cat: "Formas", path: "M52 4 C74 2 96 20 96 44 C97 66 84 92 58 96 C34 100 6 88 4 62 C2 40 14 22 26 12 C34 6 42 5 52 4 Z" },
  { name: "wave", label: "Ola", cat: "Formas", path: "M0 40 C20 20 30 20 50 40 C70 60 80 60 100 40 L100 100 L0 100 Z" },
  { name: "arch", label: "Arco", cat: "Formas", path: "M0 100 L0 50 A50 50 0 0 1 100 50 L100 100 Z" },
  { name: "semicircle", label: "Semicírculo", cat: "Formas", path: "M0 100 A50 50 0 0 1 100 100 Z" },
  // íconos
  { name: "check", label: "Palomita", cat: "Íconos", path: thick([[10, 52], [38, 80], [90, 22]], 9) },
  { name: "x-mark", label: "Equis", cat: "Íconos", path: `${thick([[12, 12], [88, 88]], 9)} ${thick([[88, 12], [12, 88]], 9)}` },
  { name: "plus", label: "Más", cat: "Íconos", path: polygon([[40, 8], [60, 8], [60, 40], [92, 40], [92, 60], [60, 60], [60, 92], [40, 92], [40, 60], [8, 60], [8, 40], [40, 40]]) },
  { name: "sun", label: "Sol", cat: "Íconos", path: sun() },
  { name: "moon", label: "Luna", cat: "Íconos", path: `${circle(46, 50, 42)} ${circle(64, 40, 36)}`, evenodd: true },
  { name: "cloud", label: "Nube", cat: "Íconos", path: "M24 80 C8 80 2 66 8 56 C12 48 20 46 26 47 C26 32 38 22 52 24 C62 25 70 32 72 40 C86 38 98 48 96 62 C95 73 86 80 76 80 Z" },
  { name: "drop", label: "Gota", cat: "Íconos", path: "M50 2 C64 26 84 44 84 64 C84 84 68 98 50 98 C32 98 16 84 16 64 C16 44 36 26 50 2 Z" },
  { name: "leaf", label: "Hoja", cat: "Íconos", path: "M8 92 C8 40 40 8 94 6 C94 60 62 92 8 92 Z M14 86 L70 30 L74 34 L18 90 Z", evenodd: true },
  { name: "bolt", label: "Rayo", cat: "Íconos", path: polygon([[58, 0], [16, 56], [44, 56], [36, 100], [84, 40], [56, 40], [66, 0]]) },
  { name: "pin", label: "Ubicación", cat: "Íconos", path: `M50 100 C34 74 14 58 14 36 A36 36 0 0 1 86 36 C86 58 66 74 50 100 Z ${circle(50, 36, 14)}`, evenodd: true },
  { name: "home", label: "Casa", cat: "Íconos", path: polygon([[50, 6], [96, 46], [84, 46], [84, 94], [60, 94], [60, 66], [40, 66], [40, 94], [16, 94], [16, 46], [4, 46]]) },
  { name: "speech", label: "Globo de diálogo", cat: "Íconos", path: "M14 8 L86 8 Q96 8 96 18 L96 62 Q96 72 86 72 L44 72 L22 94 L26 72 L14 72 Q4 72 4 62 L4 18 Q4 8 14 8 Z" },
  { name: "tag", label: "Etiqueta", cat: "Íconos", path: `M4 14 Q4 4 14 4 L54 4 L96 46 L46 96 L4 54 Z ${circle(26, 26, 8)}`, evenodd: true },
  { name: "bookmark", label: "Marcador", cat: "Íconos", path: polygon([[18, 2], [82, 2], [82, 98], [50, 74], [18, 98]]) },
  { name: "play", label: "Reproducir", cat: "Íconos", path: `${circle(50, 50, 48)} ${polygon([[40, 28], [72, 50], [40, 72]])}`, evenodd: true },
  { name: "music", label: "Música", cat: "Íconos", path: `${circle(26, 80, 16)} ${circle(76, 70, 16)} ${polygon([[36, 80], [36, 18], [92, 6], [92, 70], [84, 70], [84, 26], [44, 34], [44, 80]])}` },
  { name: "camera", label: "Cámara", cat: "Íconos", path: `M10 26 L30 26 L38 14 L62 14 L70 26 L90 26 Q98 26 98 34 L98 82 Q98 90 90 90 L10 90 Q2 90 2 82 L2 34 Q2 26 10 26 Z ${circle(50, 56, 20)}`, evenodd: true },
  { name: "mail", label: "Correo", cat: "Íconos", path: "M4 18 L96 18 L96 82 L4 82 Z M10 24 L50 54 L90 24 L90 28 L50 60 L10 28 Z", evenodd: true },
  { name: "phone", label: "Teléfono", cat: "Íconos", path: "M24 4 C30 4 36 18 38 26 C39 32 32 36 30 40 C36 54 46 64 60 70 C64 68 68 61 74 62 C82 64 96 70 96 76 C96 88 86 96 76 96 C40 94 6 60 4 24 C4 14 12 4 24 4 Z" },
  { name: "gift", label: "Regalo", cat: "Íconos", path: "M6 30 L94 30 L94 48 L6 48 Z M12 52 L88 52 L88 96 L12 96 Z M44 30 L56 30 L56 96 L44 96 Z M50 28 C40 10 20 10 24 22 C26 28 40 29 50 28 Z M50 28 C60 10 80 10 76 22 C74 28 60 29 50 28 Z" },
  { name: "trophy", label: "Trofeo", cat: "Íconos", path: "M24 6 L76 6 L76 34 C76 50 64 60 56 62 L56 76 L70 76 L70 94 L30 94 L30 76 L44 76 L44 62 C36 60 24 50 24 34 Z M24 12 L8 12 C8 32 16 40 26 42 L26 36 C18 34 14 28 14 18 L24 18 Z M76 12 L92 12 C92 32 84 40 74 42 L74 36 C82 34 86 28 86 18 L76 18 Z" },
  { name: "arrow-circle", label: "Flecha circular", cat: "Íconos", path: `${circle(50, 50, 48)} ${polygon([[24, 44], [56, 44], [56, 28], [80, 50], [56, 72], [56, 56], [24, 56]])}`, evenodd: true },
  { name: "heart-outline", label: "Corazón (contorno)", cat: "Íconos", path: "M50 92 C20 70 2 52 4 30 C6 12 28 4 50 24 C72 4 94 12 96 30 C98 52 80 70 50 92 Z M50 78 C28 62 14 48 14 32 C14 20 30 14 50 34 C70 14 86 20 86 32 C86 48 72 62 50 78 Z", evenodd: true },
  { name: "quote", label: "Comillas", cat: "Íconos", path: "M6 52 C6 28 18 14 40 10 L42 20 C30 24 24 32 24 44 L42 44 L42 86 L6 86 Z M56 52 C56 28 68 14 90 10 L92 20 C80 24 74 32 74 44 L92 44 L92 86 L56 86 Z" },
];

const cache = new Map();
/** El Path2D de un gráfico (o null si no existe). Path2D solo existe en el navegador. */
export function graphicPath(name) {
  if (cache.has(name)) return cache.get(name);
  const g = GRAPHICS.find((item) => item.name === name);
  const value = g && typeof Path2D !== "undefined" ? { path: new Path2D(g.path), evenodd: Boolean(g.evenodd) } : null;
  cache.set(name, value);
  return value;
}
