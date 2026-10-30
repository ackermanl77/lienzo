"""Guardado en disco: diseños (JSON), sus miniaturas (PNG) e imágenes subidas.

Todo vive en ``paths.data_dir()``:

    designs/<id>.json      el diseño validado por model.sanitize_design
    thumbs/<id>.png        miniatura de la primera página (la dibuja el editor)
    assets/<id>.<ext>      imágenes y videos subidos, con su índice en assets/index.json
    settings.json          ajustes (servidor de IA local)
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

from PIL import Image, UnidentifiedImageError

from . import model, paths

MAX_ASSET_BYTES = 30 * 1024 * 1024
MAX_ASSET_PIXELS = 60_000_000
MAX_THUMB_BYTES = 2 * 1024 * 1024
ASSET_FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp"),
                 "GIF": ("gif", "image/gif")}
MAX_VIDEO_BYTES = 300 * 1024 * 1024
VIDEO_FORMATS = {"mp4": "video/mp4", "webm": "video/webm"}
MIME_BY_EXT = {**{ext: mime for ext, mime in ASSET_FORMATS.values()}, **VIDEO_FORMATS}

_lock = threading.RLock()


class StoreError(ValueError):
    """Un problema que el usuario puede corregir (el mensaje es para él)."""


class SaveConflict(StoreError):
    """El diseño cambió desde que el cliente lo abrió."""


def _dir(name: str) -> str:
    path = os.path.join(paths.data_dir(), name)
    os.makedirs(path, exist_ok=True)
    return path


def atomic_write(path: str, data: bytes) -> None:
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        for attempt in range(5):  # Windows: un antivirus puede tener el destino abierto un instante
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ---------------- kit de marca (UI4) ----------------
def _brand_path() -> str:
    return os.path.join(paths.data_dir(), "brand.json")


def load_brand() -> Dict[str, Any]:
    try:
        with open(_brand_path(), encoding="utf-8") as f:
            return model.sanitize_brand(json.load(f))
    except (OSError, ValueError):
        return model.sanitize_brand({})


def save_brand(raw: Any) -> Dict[str, Any]:
    brand = model.sanitize_brand(raw)
    with _lock:
        os.makedirs(paths.data_dir(), exist_ok=True)
        atomic_write(_brand_path(), json.dumps(brand, ensure_ascii=False).encode("utf-8"))
    return brand


# ---------------- diseños ----------------
def _design_path(design_id: str) -> str:
    if not model.is_design_id(design_id):
        raise StoreError("Diseño no encontrado.")
    return os.path.join(_dir("designs"), f"{design_id}.json")


def thumb_path(design_id: str) -> str:
    if not model.is_design_id(design_id):
        raise StoreError("Diseño no encontrado.")
    return os.path.join(_dir("thumbs"), f"{design_id}.png")


def load_design(design_id: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_design_path(design_id), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save_design(raw: Any, thumbnail: Optional[str] = None,
                expected_updated: Optional[float] = None) -> Dict[str, Any]:
    design = model.sanitize_design(raw)
    with _lock:
        old = load_design(design["id"])
        if old:
            design["created"] = old.get("created", design["created"])
        if expected_updated is not None:
            if old is None:
                raise SaveConflict("El diseño cambió en otra pestaña o fue eliminado.")
            if old.get("updated") != expected_updated:
                current = {key: value for key, value in old.items() if key != "updated"}
                candidate = {key: value for key, value in design.items() if key != "updated"}
                if current == candidate:
                    return old
                raise SaveConflict("El diseño cambió en otra pestaña.")
            design["updated"] = max(design["updated"], old["updated"] + 0.000001)
        design_path = _design_path(design["id"])
        thumbnail_path = thumb_path(design["id"])
        thumbnail_bytes = decode_png_data_url(thumbnail, MAX_THUMB_BYTES) if thumbnail else None
        previous_design = None
        if os.path.exists(design_path):
            with open(design_path, "rb") as f:
                previous_design = f.read()
        design_bytes = json.dumps(design, ensure_ascii=False).encode("utf-8")
        try:
            atomic_write(design_path, design_bytes)
            if thumbnail_bytes is not None:
                atomic_write(thumbnail_path, thumbnail_bytes)
        except OSError:
            if previous_design is None:
                try:
                    os.remove(design_path)
                except FileNotFoundError:
                    pass
            else:
                atomic_write(design_path, previous_design)
            raise
    return design


def summary(design: Dict[str, Any]) -> Dict[str, Any]:
    has_thumb = os.path.exists(thumb_path(design["id"]))
    return {
        "id": design["id"], "title": design["title"], "format": design.get("format", "custom"),
        "width": design["width"], "height": design["height"], "pages": len(design.get("pages", [])),
        "updated": design.get("updated", 0),
        "thumb": f"/thumbs/{design['id']}.png?v={int(design.get('updated', 0))}" if has_thumb else None,
    }


def list_designs() -> List[Dict[str, Any]]:
    items = []
    for name in os.listdir(_dir("designs")):
        if name.endswith(".json"):
            design = load_design(name[:-5])
            if design and model.is_design_id(design.get("id")):
                items.append(summary(design))
    return sorted(items, key=lambda d: d["updated"], reverse=True)


def delete_design(design_id: str) -> bool:
    with _lock:
        path = _design_path(design_id)
        if not os.path.exists(path):
            return False
        os.remove(path)
        if os.path.exists(thumb_path(design_id)):
            os.remove(thumb_path(design_id))
    return True


def duplicate_design(design_id: str) -> Dict[str, Any]:
    design = load_design(design_id)
    if design is None:
        raise StoreError("Diseño no encontrado.")
    copy = dict(design, id=model.new_id(), title=f"{design['title']} (copia)"[: model.MAX_TITLE], created=None)
    saved = save_design(copy)
    if os.path.exists(thumb_path(design_id)):
        with open(thumb_path(design_id), "rb") as f:
            atomic_write(thumb_path(saved["id"]), f.read())
    return saved


def decode_png_data_url(data_url: Any, limit: int) -> bytes:
    """Los bytes de un data URL PNG validado con Pillow."""
    prefix = "data:image/png;base64,"
    if not isinstance(data_url, str) or not data_url.startswith(prefix):
        raise StoreError("Imagen inválida.")
    try:
        data = base64.b64decode(data_url[len(prefix):], validate=True)
    except (binascii.Error, ValueError):
        raise StoreError("Imagen inválida.") from None
    if len(data) > limit:
        raise StoreError("La imagen es demasiado grande.")
    _open_image(data, "PNG")
    return data


def _open_image(data: bytes, expected: Optional[str] = None) -> Image.Image:
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        image = Image.open(io.BytesIO(data))
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise StoreError("El archivo no es una imagen válida.") from None
    if expected and image.format != expected:
        raise StoreError("Formato de imagen inesperado.")
    if image.width * image.height > MAX_ASSET_PIXELS:
        raise StoreError("La imagen tiene demasiados píxeles (máximo 60 millones).")
    return image


# ---------------- imágenes subidas ----------------
def _asset_index() -> Dict[str, Any]:
    try:
        with open(os.path.join(_dir("assets"), "index.json"), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_asset_index(index: Dict[str, Any]) -> None:
    atomic_write(os.path.join(_dir("assets"), "index.json"), json.dumps(index, ensure_ascii=False).encode("utf-8"))


def _asset_view(asset_id: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    view = {"id": asset_id, "name": meta.get("name", ""), "width": meta.get("width"), "height": meta.get("height"),
            "url": f"/assets/{asset_id}", "added": meta.get("added", 0), "kind": meta.get("kind", "image")}
    if isinstance(meta.get("credit"), dict):
        view["credit"] = meta["credit"]
    if meta.get("duration"):
        view["duration"] = meta["duration"]
    return view


def _register(data: bytes, ext: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    asset_id = model.new_id(16)
    meta = {"ext": ext, "added": time.time(), **meta}
    with _lock:
        asset_path = os.path.join(_dir("assets"), f"{asset_id}.{ext}")
        atomic_write(asset_path, data)
        try:
            index = _asset_index()
            index[asset_id] = meta
            _save_asset_index(index)
        except Exception:
            try:
                os.remove(asset_path)
            except OSError:
                pass
            raise
    return _asset_view(asset_id, meta)


def video_kind(data: bytes) -> Optional[str]:
    """mp4 (caja 'ftyp') o webm (cabecera EBML), o None."""
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "mp4"
    if data[:4] == bytes.fromhex("1a45dfa3"):
        return "webm"
    return None


def add_video(data: bytes, name: str, width: Any, height: Any, duration: Any) -> Dict[str, Any]:
    """Un video subido. Python no decodifica video: el tamaño y la duración los mide
    la página (que ya lo cargó) y aquí solo se acotan."""
    if not data:
        raise StoreError("El archivo está vacío.")
    if len(data) > MAX_VIDEO_BYTES:
        raise StoreError("El video pesa más de 300 MB.")
    ext = video_kind(data)
    if ext is None:
        raise StoreError("Formatos de video admitidos: MP4 y WEBM.")
    try:
        w, h, secs = int(width), int(height), float(duration)
    except (TypeError, ValueError):
        raise StoreError("No se pudo leer el tamaño del video.") from None
    if not (1 <= w <= 8192 and 1 <= h <= 8192) or not (0 < secs <= 3600):
        raise StoreError("Tamaño o duración de video fuera de rango.")
    return _register(data, ext, {"kind": "video", "name": os.path.basename(name or "")[:120] or f"video.{ext}",
                                 "width": w, "height": h, "duration": round(secs, 2)})


def add_asset(data: bytes, name: str = "", credit: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    if not data:
        raise StoreError("El archivo está vacío.")
    if len(data) > MAX_ASSET_BYTES:
        raise StoreError("La imagen pesa más de 30 MB.")
    image = _open_image(data)
    if image.format not in ASSET_FORMATS:
        raise StoreError("Formatos admitidos: PNG, JPG, WEBP y GIF.")
    ext = ASSET_FORMATS[image.format][0]
    meta: Dict[str, Any] = {"name": os.path.basename(name or "")[:120] or f"imagen.{ext}", "width": image.width,
                            "height": image.height}
    if credit:
        meta["credit"] = credit
    return _register(data, ext, meta)


def asset_bytes(asset_id: str) -> bytes:
    found = asset_file(asset_id)
    if not found or found[1].startswith("video/"):
        raise StoreError("Imagen no encontrada.")
    with open(found[0], "rb") as f:
        return f.read()


def list_assets() -> List[Dict[str, Any]]:
    index = _asset_index()
    items = [_asset_view(asset_id, meta) for asset_id, meta in index.items()
             if model.is_asset_id(asset_id) and isinstance(meta, dict) and not meta.get("hidden")]
    return sorted(items, key=lambda a: a["added"], reverse=True)


def asset_file(asset_id: str) -> Optional[tuple]:
    """(ruta, tipo MIME) de una imagen subida, o None."""
    meta = _asset_index().get(asset_id) if model.is_asset_id(asset_id) else None
    ext = meta.get("ext") if isinstance(meta, dict) else None
    if ext not in MIME_BY_EXT:
        return None
    path = os.path.join(_dir("assets"), f"{asset_id}.{ext}")
    return (path, MIME_BY_EXT[ext]) if os.path.isfile(path) else None


def delete_asset(asset_id: str) -> bool:
    """Quita la imagen de "Subidos". El archivo se conserva: los diseños que ya
    la usan la siguen mostrando."""
    with _lock:
        index = _asset_index()
        meta = index.get(asset_id) if model.is_asset_id(asset_id) else None
        if not isinstance(meta, dict) or meta.get("hidden"):
            return False
        meta["hidden"] = True
        _save_asset_index(index)
    return True


# ---------------- ajustes ----------------
DEFAULT_SETTINGS = {"ai_url": "http://127.0.0.1:11434/v1", "ai_model": ""}


def load_settings() -> Dict[str, Any]:
    try:
        with open(os.path.join(paths.data_dir(), "settings.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    return {**DEFAULT_SETTINGS, **(data if isinstance(data, dict) else {})}


def save_settings(values: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        settings = {**load_settings(), **values}
        atomic_write(os.path.join(paths.data_dir(), "settings.json"),
                     json.dumps(settings, ensure_ascii=False, indent=1).encode("utf-8"))
    return settings
