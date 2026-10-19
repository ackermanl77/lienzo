"""La ventana de escritorio: el servidor local en un hilo y el editor en una
ventana nativa (pywebview + WebView2 en Windows).

La página llama a ``window.pywebview.api.elegir_destino(nombre, ext)`` para
el diálogo nativo "Guardar como" de las exportaciones.
"""

from __future__ import annotations

import os
import threading
from typing import Optional

from .server import LienzoServer

_FILE_TYPES = {
    "png": "Imagen PNG (*.png)", "jpg": "Imagen JPG (*.jpg)", "pdf": "Documento PDF (*.pdf)",
    "zip": "Archivo ZIP (*.zip)", "mp4": "Video MP4 (*.mp4)", "webm": "Video WEBM (*.webm)",
}


class Bridge:
    """Funciones de Python que la página puede llamar."""

    def __init__(self) -> None:
        self._window = None  # privado: pywebview expone a la página todo atributo público

    def elegir_destino(self, nombre: str, ext: str) -> Optional[str]:
        import webview

        ext = ext if ext in _FILE_TYPES else "png"
        dialog = getattr(getattr(webview, "FileDialog", None), "SAVE", None) or webview.SAVE_DIALOG
        result = self._window.create_file_dialog(
            dialog, directory=os.path.join(os.path.expanduser("~"), "Documents"),
            save_filename=f"{nombre}.{ext}", file_types=(_FILE_TYPES[ext], "Todos los archivos (*.*)"))
        if not result:
            return None
        return result if isinstance(result, str) else result[0]


def run(port: int = 0, debug: bool = False) -> int:
    import webview

    server = LienzoServer(port=port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    bridge = Bridge()
    window = webview.create_window("Lienzo", server.url, js_api=bridge, width=1440, height=900,
                                   min_size=(980, 640), background_color="#f4f2fb")
    bridge._window = window
    try:
        webview.start(debug=debug, private_mode=False)
    finally:
        server.shutdown()
        server.server_close()
    return 0
