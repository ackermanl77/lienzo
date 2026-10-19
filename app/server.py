"""Servidor local de Lienzo: la página del editor (web/) y una API JSON.

Solo escucha en 127.0.0.1. La API pide la cabecera ``X-Lienzo-Token`` (la
clave llega a la página en el enlace ``?t=``); una cabecera propia obliga al
navegador a una consulta previa CORS que este servidor no contesta, así que
otra página web no puede llamar a la API. Además se rechaza cualquier
``Host`` que no sea esta máquina (contra el "DNS rebinding").

Rutas de la API:
    GET    /api/formatos
    GET    /api/plantillas?ancho=&alto=
    GET    /api/disenos                      lista (resumen + miniatura)
    POST   /api/disenos                      {formato} o {ancho, alto}, [titulo], [plantilla]
    GET    /api/disenos/<id>
    PUT    /api/disenos/<id>                 {diseno, miniatura?}
    DELETE /api/disenos/<id>
    POST   /api/disenos/<id>/duplicar
    GET    /api/imagenes
    POST   /api/imagenes                     cuerpo = bytes de la imagen, X-Filename
    DELETE /api/imagenes/<id>
    POST   /api/exportar                     {formato, paginas[], titulo, diseno, escala, ruta?}
    POST   /api/guardar-archivo              cuerpo = archivo (video exportado), X-Ruta
    POST   /api/videos                       cuerpo = MP4/WEBM, X-Filename, X-Width, X-Height, X-Duration
    POST   /api/imagenes/<id>/quitar-fondo   {tolerancia}
    GET    /api/stock/buscar?q=&pagina=      fotos de Openverse
    POST   /api/stock/importar               {id}
    GET    /api/fuentes                      instaladas + catálogo de Google Fonts
    POST   /api/fuentes/google               {familia}
    POST   /api/fuentes/subir                cuerpo = .ttf/.otf/.woff/.woff2, X-Filename, X-Family
    DELETE /api/fuentes?familia=
    GET    /api/ia/estado | PUT /api/ia/ajustes {url, modelo}
    POST   /api/ia/escribir {instruccion, idioma} | /api/ia/reescribir {texto, modo} | /api/ia/diseno {...}
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import secrets
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from . import ai, exporter, fonts, imaging, model, paths, stock, store, templates

logger = logging.getLogger(__name__)

MAX_JSON_BYTES = 40 * 1024 * 1024
MAX_EXPORT_BYTES = 600 * 1024 * 1024
SAVE_EXTENSIONS = (".webm", ".mp4", ".png", ".jpg", ".pdf", ".zip")
TOKEN_HEADER = "X-Lienzo-Token"


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


Route = Tuple[str, "re.Pattern[str]", Callable[..., Any]]
ROUTES: List[Route] = []


def route(method: str, pattern: str):
    def register(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn))
        return fn
    return register


def _design_or_404(design_id: str) -> Dict[str, Any]:
    design = store.load_design(design_id) if model.is_design_id(design_id) else None
    if design is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Diseño no encontrado.")
    return design


@route("GET", r"/api/formatos")
def _formats(req, m):
    return model.formats()


@route("GET", r"/api/plantillas")
def _templates(req, m):
    q = req.query
    return templates.templates_for(q.get("ancho", ["1080"])[0], q.get("alto", ["1080"])[0])


@route("GET", r"/api/disenos")
def _list(req, m):
    return store.list_designs()


@route("POST", r"/api/disenos")
def _create(req, m):
    body = req.json()
    fmt = body.get("formato")
    if fmt in model.FORMATS:
        width, height = model.FORMATS[fmt][1:3]
    else:
        fmt = "custom"
        width, height = model.check_size(body.get("ancho"), body.get("alto"))
    pages = None
    if body.get("plantilla"):
        pages = [templates.template_page(str(body["plantilla"]), width, height)]
    design = model.new_design(width, height, str(body.get("titulo") or ""), fmt, pages)
    return store.save_design(design)


@route("GET", r"/api/disenos/([0-9a-f]{12})")
def _get(req, m):
    return _design_or_404(m.group(1))


@route("PUT", r"/api/disenos/([0-9a-f]{12})")
def _put(req, m):
    body = req.json()
    design = body.get("diseno")
    if not isinstance(design, dict) or design.get("id") != m.group(1):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Diseño inválido.")
    saved = store.save_design(design, body.get("miniatura"))
    return {"id": saved["id"], "updated": saved["updated"], "title": saved["title"]}


@route("DELETE", r"/api/disenos/([0-9a-f]{12})")
def _delete(req, m):
    if not store.delete_design(m.group(1)):
        raise ApiError(HTTPStatus.NOT_FOUND, "Diseño no encontrado.")
    return {}


@route("POST", r"/api/disenos/([0-9a-f]{12})/duplicar")
def _duplicate(req, m):
    return store.summary(store.duplicate_design(m.group(1)))


@route("GET", r"/api/imagenes")
def _assets(req, m):
    return store.list_assets()


@route("POST", r"/api/imagenes")
def _upload(req, m):
    return store.add_asset(req.raw_body(store.MAX_ASSET_BYTES), unquote(req.headers.get("X-Filename", "")))


@route("DELETE", r"/api/imagenes/([0-9a-f]{16})")
def _delete_asset(req, m):
    if not store.delete_asset(m.group(1)):
        raise ApiError(HTTPStatus.NOT_FOUND, "Imagen no encontrada.")
    return {}


@route("POST", r"/api/exportar")
def _export(req, m):
    body = req.json(MAX_EXPORT_BYTES)
    pages = body.get("paginas")
    if not isinstance(pages, list) or not all(isinstance(p, str) for p in pages) or len(pages) > model.MAX_PAGES:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Páginas inválidas.")
    # ppp del formato del diseño (300 en impresos); a 2x el doble, para conservar el tamaño físico.
    design = store.load_design(body["diseno"]) if model.is_design_id(body.get("diseno")) else None
    scale = body.get("escala") if body.get("escala") in (1, 2) else 1
    dpi = (model.dpi_for(design) if design else 96) * scale
    data, name, mime = exporter.build(str(body.get("formato")), pages, str(body.get("titulo") or ""), dpi)
    target = body.get("ruta")
    if target:
        # La ruta viene del diálogo "Guardar como" de la ventana de escritorio.
        target = _target_path(target)
        ext = os.path.splitext(name)[1]
        if not target.lower().endswith(ext):
            target += ext
        store.atomic_write(target, data)
        return {"ruta": target, "nombre": os.path.basename(target)}
    return _Download(data, name, mime)


def _target_path(target: Any) -> str:
    """Una ruta elegida en el diálogo "Guardar como" de la ventana de escritorio."""
    if not isinstance(target, str) or not os.path.isabs(target) or not os.path.isdir(os.path.dirname(target)):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Carpeta de destino inválida.")
    return target


@route("POST", r"/api/guardar-archivo")
def _save_file(req, m):
    target = _target_path(unquote(req.headers.get("X-Ruta", "")))
    if not target.lower().endswith(SAVE_EXTENSIONS):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Tipo de archivo no permitido.")
    store.atomic_write(target, req.raw_body(MAX_EXPORT_BYTES))
    return {"ruta": target, "nombre": os.path.basename(target)}


@route("POST", r"/api/videos")
def _upload_video(req, m):
    h = req.headers
    return store.add_video(req.raw_body(store.MAX_VIDEO_BYTES), unquote(h.get("X-Filename", "")),
                           h.get("X-Width"), h.get("X-Height"), h.get("X-Duration"))


@route("POST", r"/api/imagenes/([0-9a-f]{16})/quitar-fondo")
def _remove_background(req, m):
    body = req.json()
    tolerance = body.get("tolerancia") if isinstance(body.get("tolerancia"), int) else 40
    return imaging.remove_background_asset(m.group(1), tolerance)


@route("GET", r"/api/stock/buscar")
def _stock_search(req, m):
    try:
        page = int(req.query.get("pagina", ["1"])[0])
    except ValueError:
        page = 1
    return stock.search(req.query.get("q", [""])[0], page)


@route("POST", r"/api/stock/importar")
def _stock_import(req, m):
    return stock.import_image(str(req.json().get("id", "")))


@route("GET", r"/api/fuentes")
def _fonts(req, m):
    return {"instaladas": fonts.installed(), "catalogo": list(fonts.CATALOG)}


@route("POST", r"/api/fuentes/google")
def _font_google(req, m):
    return fonts.install_google(req.json().get("familia"))


@route("POST", r"/api/fuentes/subir")
def _font_upload(req, m):
    return fonts.install_file(req.raw_body(fonts.MAX_FONT_BYTES), unquote(req.headers.get("X-Family", "")),
                              unquote(req.headers.get("X-Filename", "")))


@route("DELETE", r"/api/fuentes")
def _font_delete(req, m):
    if not fonts.remove(req.query.get("familia", [""])[0]):
        raise ApiError(HTTPStatus.NOT_FOUND, "Fuente no encontrada.")
    return {}


@route("GET", r"/api/ia/estado")
def _ai_status(req, m):
    return ai.status()


@route("PUT", r"/api/ia/ajustes")
def _ai_settings(req, m):
    body = req.json()
    return ai.save_settings(body.get("url"), body.get("modelo"))


@route("POST", r"/api/ia/escribir")
def _ai_write(req, m):
    body = req.json()
    return {"texto": ai.write(body.get("instruccion"), body.get("idioma", "es"))}


@route("POST", r"/api/ia/reescribir")
def _ai_rewrite(req, m):
    body = req.json()
    return {"texto": ai.rewrite(body.get("texto"), str(body.get("modo", "")))}


@route("POST", r"/api/ia/diseno")
def _ai_design(req, m):
    body = req.json()
    width, height = model.check_size(body.get("ancho"), body.get("alto"))
    return ai.magic_design(body.get("descripcion"), width, height, str(body.get("estilo") or ""),
                           body.get("idioma", "es"))


class _Download:
    def __init__(self, data: bytes, name: str, mime: str) -> None:
        self.data, self.name, self.mime = data, name, mime


class Handler(BaseHTTPRequestHandler):
    server_version = "Lienzo"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # silencioso; los errores van al logger
        pass

    # ---------- utilidades ----------
    def _send(self, status: int, payload: bytes, content_type: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _json(self, status: int, data: Any) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def raw_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > limit:
            self.close_connection = True
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "El envío es demasiado grande.")
        self._body_read = True
        return self.rfile.read(length) if length else b""

    def json(self, limit: int = MAX_JSON_BYTES) -> Dict[str, Any]:
        raw = self.raw_body(limit)
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, ValueError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "JSON inválido.") from None
        if not isinstance(data, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "JSON inválido.")
        return data

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1")

    # ---------- despacho ----------
    def _handle(self) -> None:
        self._body_read = False
        url = urlsplit(self.path)
        self.query = parse_qs(url.query)
        try:
            if not self._host_ok():
                raise ApiError(HTTPStatus.FORBIDDEN, "Origen no permitido.")
            if url.path.startswith("/api/"):
                if not secrets.compare_digest(self.headers.get(TOKEN_HEADER, ""), self.server.token):
                    raise ApiError(HTTPStatus.UNAUTHORIZED, "Falta la clave de acceso: abre Lienzo desde su ventana.")
                self._api(url.path)
            elif self.command in ("GET", "HEAD"):
                self._static(url.path)
            else:
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "Método no permitido.")
        except ApiError as exc:
            self._error(exc.status, exc.message)
        except (model.DesignError, store.StoreError, ai.AIError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: BLE001 - nunca tumbar el servidor por una petición
            logger.exception("Error en %s %s", self.command, url.path)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "Error interno del servidor.")

    def _error(self, status: int, message: str) -> None:
        if not self._body_read and self.command in ("POST", "PUT", "DELETE"):
            self.close_connection = True  # el cuerpo sin leer no debe colarse en la siguiente petición
        self._json(status, {"error": message})

    def _api(self, path: str) -> None:
        for method, pattern, fn in ROUTES:
            match = pattern.match(path)
            if match and method == self.command:
                result = fn(self, match)
                if isinstance(result, _Download):
                    disposition = f"attachment; filename*=UTF-8''{_quote(result.name)}"
                    self._send(HTTPStatus.OK, result.data, result.mime, {"Content-Disposition": disposition})
                else:
                    self._json(HTTPStatus.OK, result)
                return
        raise ApiError(HTTPStatus.NOT_FOUND, "Ruta no encontrada.")

    def _static(self, path: str) -> None:
        if path.startswith("/assets/"):
            found = store.asset_file(path[len("/assets/"):])
            if not found:
                raise ApiError(HTTPStatus.NOT_FOUND, "Imagen no encontrada.")
            self._send_file(found[0], found[1])
            return
        if path.startswith("/fonts/"):
            found = fonts.font_file(path[len("/fonts/"):])
            if not found:
                raise ApiError(HTTPStatus.NOT_FOUND, "Fuente no encontrada.")
            self._send_file(found[0], found[1])
            return
        if path.startswith("/thumbs/"):
            name = path[len("/thumbs/"):]
            design_id = name[:-4] if name.endswith(".png") else ""
            if not model.is_design_id(design_id) or not os.path.isfile(store.thumb_path(design_id)):
                raise ApiError(HTTPStatus.NOT_FOUND, "Miniatura no encontrada.")
            with open(store.thumb_path(design_id), "rb") as f:
                self._send(HTTPStatus.OK, f.read(), "image/png")
            return
        pages = {"/": "index.html", "": "index.html", "/editor": "editor.html"}
        relative = pages.get(path, path.lstrip("/"))
        root = os.path.realpath(paths.web_dir())
        target = os.path.realpath(os.path.join(root, relative))
        if not target.startswith(root + os.sep) or not os.path.isfile(target):
            raise ApiError(HTTPStatus.NOT_FOUND, "No encontrado.")
        mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if target.endswith(".js") or target.endswith(".mjs"):
            mime = "text/javascript"
        if mime.startswith("text/") or mime == "image/svg+xml":
            mime += "; charset=utf-8"
        with open(target, "rb") as f:
            self._send(HTTPStatus.OK, f.read(), mime)

    def _send_file(self, path: str, mime: str) -> None:
        """Un archivo con soporte de rangos (los videos los piden para buscar)."""
        size = os.path.getsize(path)
        start, end = 0, size - 1
        status = HTTPStatus.OK
        match = re.match(r"^bytes=(\d*)-(\d*)$", self.headers.get("Range", "").strip())
        if match and size:
            if match.group(1):
                start = int(match.group(1))
                end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            elif match.group(2):
                start = max(0, size - int(match.group(2)))
            if start > end or start >= size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1 if size else 0
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD" or not length:
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _handle


def _quote(name: str) -> str:
    from urllib.parse import quote
    return quote(name, safe="")


class LienzoServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int = 0, token: Optional[str] = None) -> None:
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token or secrets.token_urlsafe(24)
        self.port = self.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/?t={self.token}"
