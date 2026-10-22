# Lienzo

Editor de diseños de escritorio para Windows, sin internet: publicaciones,
historias, presentaciones, carteles, tarjetas. Inspirado en el modelo de
diseños que Canva documenta públicamente (ver
[docs/EVIDENCIA.md](docs/EVIDENCIA.md)), con nombre, diseño y código propios.

## Qué hace

- **Inicio**: 12 formatos listos (Instagram, Facebook, YouTube, presentación
  16:9, A4, A3, carta, tarjeta, invitación, logo) o tamaño propio
  (40–8000 px por lado), 8 plantillas, y tus diseños con miniatura (abrir,
  duplicar, eliminar).
- **Editor**:
  - Texto, formas (rectángulo, redondeado, círculo, triángulo, rombo,
    hexágono, estrella, corazón, flecha, línea) e imágenes propias (subir,
    arrastrar y soltar, o pegar con Ctrl+V).
  - Seleccionar (también varios con Mayús o arrastrando un recuadro), mover,
    cambiar tamaño y girar con tiradores. Hay guías inteligentes contra los
    bordes y centros de la página y de otros elementos (Alt las desactiva).
  - Texto: fuente, tamaño, color, negrita/cursiva/subrayado, alineación e
    interlineado. Se escribe con doble clic sobre el lienzo.
  - Formas e imágenes: color, borde, esquinas redondeadas y opacidad.
  - Orden de capas, alinear a la página o entre sí, bloquear, duplicar,
    copiar/pegar y panel de Capas.
  - Fondo de color o de imagen. Varias páginas: agregar, duplicar, eliminar
    y miniaturas.
  - Deshacer/rehacer (100 pasos), zoom (Ctrl+rueda) y desplazamiento
    (rueda, o Espacio + arrastrar).
  - Guardado automático.
- **Grupos**: Ctrl+G agrupa y Ctrl+Shift+G desagrupa. Un clic elige el
  grupo y Ctrl+clic un solo elemento. Varios elementos elegidos se escalan
  y giran juntos con los tiradores.
- **Tablas**: 3×2, 4×3 o 6×4 para empezar. Doble clic en una celda para
  escribir; Tab pasa a la siguiente. Se pueden agregar o quitar filas y
  columnas; colores de encabezado, celdas, rayas y bordes. El alto de cada
  fila se ajusta a su texto.
- **Galería de gráficos**: 40 gráficos vectoriales propios (formas
  decorativas e íconos), con buscador y color, sin internet.
- **Fotos de stock**: búsqueda en [Openverse](https://openverse.org) con
  licencias Creative Commons que permiten uso comercial y modificación (sin
  clave; necesita internet). Cada foto guarda su crédito: el botón © en
  Subidos lo agrega al diseño.
- **Video**: sube MP4 o WEBM y se usan como relleno de un rectángulo, igual
  que las imágenes. Se reproducen sin sonido en el editor.
- **Animación**: entrada por elemento (aparecer, subir, deslizar, rebotar,
  acercar, caer, girar, máquina de escribir) con duración y retraso. Cada
  página tiene una duración. **Reproducir** muestra el diseño a pantalla
  completa.
- **IA local** (opcional): con un servidor de esta PC compatible con OpenAI
  (Ollama, LM Studio o llama.cpp):
  - escribir textos;
  - reescribir el texto elegido (más corto, más largo, formal, divertido,
    corregir, traducir);
  - "Diseño mágico": la IA propone textos, estilo y colores, y Lienzo arma
    la página.

  Solo se aceptan direcciones de esta PC. **Quitar fondo** (en la barra de
  una imagen) borra fondos lisos sin IA ni internet.
- **Fuentes descargables**: Google Fonts por nombre (una selección de 82 o
  cualquier otra) o archivos propios (.ttf, .otf, .woff, .woff2). Quedan
  instaladas para usarlas sin internet.
- **Descargar**: PNG, JPG o PDF, todas las páginas o solo la actual, a 1× o
  2×. **Video** (MP4, o WEBM si el sistema no puede MP4): graba las
  animaciones y los videos en tiempo real, sin sonido, hasta 1920 px. Los formatos impresos salen a 300 ppp. Varias páginas en imagen se
  descargan como .zip. En la ventana de escritorio se usa el diálogo
  "Guardar como".

Los datos viven en `%LOCALAPPDATA%\Lienzo` (diseños, miniaturas, imágenes
subidas y registro); `LIENZO_DATA_DIR` lo cambia. Cada diseño se guarda de
forma atómica, y si no se puede escribir su miniatura se vuelve al diseño
guardado antes, así que nunca queda a medias.

## Usar

```powershell
py -3.14 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
.venv\Scripts\python lienzo.py               # ventana de escritorio
.venv\Scripts\python lienzo.py --navegador   # en el navegador (para probar)
```

Atajos: Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V / Ctrl+X, Ctrl+D (duplicar),
Supr (eliminar), flechas (mover 1 px, con Mayús 10 px), Ctrl+A,
Ctrl+B / I / U, Ctrl+] / Ctrl+[ (orden), Ctrl+0 (ajustar), Ctrl+S (guardar),
Enter (editar el texto seleccionado), Esc.

## Empaquetar

`build.bat` crea un entorno limpio (`.build-venv`) y genera
`dist\Lienzo\Lienzo.exe` con PyInstaller. Luego prueba el ejecutable
(`scripts\smoke_test.ps1`) y, si está Inno Setup 6, genera el instalador
`dist\installer\Lienzo-<versión>-setup.exe` (en español, sin permisos de
administrador).

## Pruebas

```powershell
.venv\Scripts\python -m pytest -q          # modelo, plantillas, guardado, exportación, servidor
node --test tests/js/model.test.mjs        # geometría, texto, guías e historial del editor
.venv\Scripts\python -m ruff check app tests
```

Última corrida (2026-10-22, Python 3.14): 55 pruebas de Python y 12 de
JavaScript, todas pasan.

## Estructura

```
app/
  model.py      modelo del diseño (páginas, elementos rect/shape/text) y validación
  templates.py  plantillas en proporciones (sirven en cualquier tamaño)
  store.py      diseños, miniaturas e imágenes subidas en disco
  exporter.py   PNG / JPG / ZIP / PDF con Pillow
  fonts.py      fuentes de Google Fonts y archivos propios
  stock.py      fotos de Openverse (búsqueda e importación con crédito)
  ai.py         IA local (servidor compatible con OpenAI en esta PC)
  imaging.py    quitar fondos lisos
  net.py        descargas https con límites y sin direcciones privadas
  server.py     servidor local (solo 127.0.0.1) + API JSON con clave de acceso
  desktop.py    ventana pywebview (WebView2) y el diálogo "Guardar como"
  main.py       punto de entrada (--navegador, --puerto, --depurar); __main__.py: python -m app
  paths.py      dónde viven los datos del usuario y los archivos de la página
web/
  index.html, editor.html, css/app.css
  js/model.js   geometría, texto, guías, historial (sin DOM; probado con Node)
  js/render.js  dibuja páginas en Canvas 2D (editor, miniaturas, video y exportación)
  js/player.js  reproducción a pantalla completa y grabación de video
  js/graphics.js galería de gráficos vectoriales
  js/editor.js  el editor
  js/home.js, js/api.js, js/icons.js, img/icon.svg
scripts/smoke_test.ps1  prueba el .exe empaquetado
docs/EVIDENCIA.md  la evidencia pública de Canva y la de REA sobre Lienzo
```

## Seguridad

- El servidor escucha solo en 127.0.0.1.
- La API pide la cabecera `X-Lienzo-Token`, cuya clave cambia en cada
  arranque y llega a la página en el enlace. Una cabecera propia obliga a una
  consulta CORS previa que el servidor no contesta, así que otra página web
  no puede llamar a la API.
- Se rechaza cualquier `Host` que no sea esta máquina (contra el "DNS
  rebinding").
- Todo diseño pasa por `model.sanitize_design()`, y las imágenes se validan
  con Pillow (tamaño máximo de 30 MB y 60 MP).
- Los videos se validan por su firma (MP4/WEBM, máximo 300 MB) y las fuentes
  por la suya (TTF/OTF/WOFF/WOFF2).
- Las descargas de internet (`app/net.py`) son solo https, con tamaño y
  tiempo limitados, y rechazan direcciones privadas o locales. Las fotos se
  piden de nuevo a Openverse por su id; nunca se usa una URL enviada por la
  página.
- La IA solo acepta servidores en 127.0.0.1, localhost o ::1.
