# Evidencia: cómo funciona Canva y qué tomó Lienzo de ello

Fecha: 2026-10-18. Lienzo es un proyecto propio (nombre, diseño, código e
íconos propios); no copia marca, textos ni código de Canva.

## 1. Lo que se intentó con REA sobre canva.com (y por qué no siguió)

- Se abrió `https://www.canva.com/es_419/` en un Chrome sin interfaz, con un
  perfil vacío y el puerto de depuración local, para que REA lo observara de
  forma pasiva.
- Canva no sirvió su página: devolvió la verificación de Cloudflare
  ("Un momento…", con el iframe de Turnstile
  `challenges.cloudflare.com/.../turnstile/...`).
- **No se intentó saltar esa verificación.** Además, los términos de Canva
  prohíben la ingeniería inversa de su servicio, así que no se descompiló ni
  se analizó su código. El navegador se cerró.
- Decisión del usuario: usar la **documentación pública de Canva** como
  evidencia de cómo funciona, y usar **REA sobre el proyecto construido**.

## 2. Evidencia pública de Canva → decisión en Lienzo

| Evidencia (cita textual) | Fuente | En Lienzo |
|---|---|---|
| Tipos de elemento: "The supported element types include:" Embeds, Groups, Rects, Shapes, Text. "Table elements are not currently supported." | [Design Editing (canva.dev)](https://www.canva.dev/docs/apps/design-editing/) | Tipos `rect`, `shape` y `text` (`app/model.py`, `web/js/model.js`). Sin embeds, grupos ni tablas. |
| "there's no such thing as an 'image' or 'video' element. Instead, there's only rect elements, which may contain video or image content." | [Design Editing API (canva.dev)](https://canva.dev/docs/apps/traversal) | Una imagen es un `rect` con `fill.image` (el id de la imagen subida); `makeImage()` en `web/js/model.js`. |
| "A *fill* defines the interior appearance of a design ingredient." Tipos: Colors, Images, Videos. | [Design Editing](https://www.canva.dev/docs/apps/design-editing/) | `fill: {color}` o `fill: {image}`; la imagen cubre la caja y se recorta al deformarla (`drawCover` en `web/js/render.js`). Sin video. |
| "All elements share common properties like `top`, `left`, `width`, `height`, `rotation`, `transparency`, and `locked`." | [Design Editing](https://www.canva.dev/docs/apps/design-editing/) | Las mismas propiedades con los mismos nombres en cada elemento. |
| "All pages have an associated type"; las apps solo trabajan con páginas "absolute". | [Design Editing](https://www.canva.dev/docs/apps/design-editing/) | Solo páginas absolutas: cada elemento tiene posición y tamaño fijos en la página. |
| "Backgrounds are base layers that appear behind all other ingredients on a page." | [Design Editing](https://www.canva.dev/docs/apps/design-editing/) | `page.background` (color y, opcionalmente, imagen) se dibuja antes que los elementos. |
| "edits to the snapshot are not automatically reflected in the design"; "Apps must call the `sync` method for the edits to be applied" | [Design Editing](https://www.canva.dev/docs/apps/design-editing/) | El editor trabaja sobre una copia en memoria y la guarda con `PUT /api/disenos/<id>` (guardado automático a los 600 ms). |
| Tamaño propio: "Each dimension must be between 40 and 8000 pixels", área total ≤ 25,000,000 px². Presets: `doc`, `email`, `presentation`, `whiteboard`. | [Create design (Connect API)](https://www.canva.dev/docs/connect/api-reference/designs/create-design/) | `model.check_size()` aplica 40–8000 px por lado y 25 MP de área. Los formatos de inicio son propios (Instagram, presentación, A4…). |
| Formatos de exportación: PDF, JPEG, PNG, GIF, PPTX, MP4, HTML y CSV; la exportación es un trabajo asíncrono. | [Exports (Connect API)](https://canva.dev/docs/connect/api-reference/exports/) | PNG, JPG y PDF (`app/exporter.py`). Varias páginas en imagen salen en un .zip (decisión propia, no verificada en Canva). |
| Indirecto: una oferta de empleo de Canva describe su motor de dibujo con Rust, wGPU, WebAssembly y maquetación de texto avanzada. | [Oferta de empleo (Blackbird)](https://jobs.blackbird.vc/companies/canva/jobs/46324567-staff-frontend-engineer-editing-foundations-rust) | No se replica: Lienzo dibuja con Canvas 2D del navegador (WebView2). Es una fuente indirecta, no una descripción de arquitectura. |

## 3. Evidencia de REA sobre Lienzo

REA (rea-agents 6.7.0, conectado a Claude Code) observó el editor de Lienzo
en marcha a través de un Chrome local (`http://127.0.0.1:8790/editor`):

- **`inspect_web_page`**, evidencia
  `ev_c27cd2d48a6676cad39615a82ed1495fdf19d304cd80648f9b30383340da59ce`:
  215 nodos DOM, 139 nodos de accesibilidad (botones con nombre: "Inicio",
  "Nombre del diseño"…, una región `status` con `aria-live=polite`), ningún
  worker, y como único recurso de red la imagen subida servida desde
  `/assets/<id>` (`image/jpeg`, 33,742 bytes). Sin conexiones a terceros.
- **`analyze_web_bundle`**, evidencia
  `ev_8a5e4530762b6de2d28c3b9d95ef56f77fd41c118ac3efe4601de75130e087bd`:
  5 scripts analizados, 0 errores de análisis, 16,116 nodos de sintaxis.
  Grafo de módulos: `editor.js` importa `api.js`, `icons.js`, `model.js` y
  `render.js`; `render.js` importa `model.js`. Sin mapas de fuente ni rutas
  de terceros. Los "endpoint candidates" que reporta (los nombres `GET`,
  `POST`, `PUT`, `DELETE` en `api.js`) son de baja confianza, como el mismo
  REA advierte en sus limitaciones.

## 4. Funciones agregadas después (2026-10-18)

Siguen el mismo modelo: los grupos son elementos que comparten un id; las
tablas y los gráficos son tipos de elemento nuevos. El video es otro
*relleno* de `rect`, como las imágenes y videos que Canva describe.

| Función | Cómo la resuelve Lienzo |
|---|---|
| Grupos | `group` en cada elemento. Se mueven, escalan y giran juntos (`scaleElements` / `rotateElements` en `web/js/model.js`). |
| Tablas | Tipo `table`; la altura de las filas se ajusta al texto. |
| Video | `fill.video`. Se graba a MP4/WEBM con MediaRecorder sobre el mismo `<canvas>` (`web/js/player.js`). |
| Animación | Una animación de entrada por elemento y una duración por página (`animState`). |
| Stock | Fotos de Openverse con licencias CC comerciales, con su crédito, y una galería propia de gráficos vectoriales. |
| IA | Un modelo local por un servidor compatible con OpenAI (decisión del usuario: nada sale de la PC). |
| Fuentes | Google Fonts por nombre, o archivos propios. |

Hallazgos durante la prueba con los servicios reales:
- Openverse responde 403 si el User-Agent tiene caracteres no ASCII, y 401
  si se piden más de 20 resultados por página sin clave.
- Google Fonts entrega TTF completos cuando el pedido no viene de un
  navegador moderno.
- El Chrome de esta PC graba MP4 (`ftyp isom`) con MediaRecorder.

## 5. Lo que Lienzo no replica

Colaboración en tiempo real, cuentas y nube, sonido en los videos,
exportación a PPTX/GIF, efectos de video, bancos de música, modelos de IA
para generar imágenes o recortar fondos complejos, y la biblioteca de
contenido de Canva.
