"""Exportar: el editor dibuja cada página a su tamaño real (PNG) y aquí se
arman los archivos finales con Pillow.

- png / jpg: una página -> la imagen; varias -> un .zip con una por página;
- pdf: todas las páginas en un PDF, con el tamaño físico según los ppp del
  formato (300 en los impresos, 96 en los de pantalla).
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import List, Sequence, Tuple

from PIL import Image

from . import store

FORMATS = {"png": ("image/png", "png"), "jpg": ("image/jpeg", "jpg"), "pdf": ("application/pdf", "pdf")}
MAX_PAGE_BYTES = 80 * 1024 * 1024


def safe_name(title: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "", title or "").strip(" .")
    return name[:80] or "diseño"


def _images(pages: Sequence[str]) -> List[Image.Image]:
    if not pages:
        raise store.StoreError("No hay páginas para exportar.")
    return [Image.open(io.BytesIO(store.decode_png_data_url(page, MAX_PAGE_BYTES))) for page in pages]


def _flatten(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    flat = Image.new("RGB", image.size, "white")
    flat.paste(image, mask=image.getchannel("A"))
    return flat


def _encode(image: Image.Image, kind: str, dpi: int) -> bytes:
    out = io.BytesIO()
    if kind == "jpg":
        _flatten(image).save(out, "JPEG", quality=92, dpi=(dpi, dpi), optimize=True)
    else:
        image.save(out, "PNG", dpi=(dpi, dpi), optimize=False)
    return out.getvalue()


def build(kind: str, pages: Sequence[str], title: str, dpi: int = 96) -> Tuple[bytes, str, str]:
    """(bytes, nombre de archivo, tipo MIME) del archivo exportado."""
    if kind not in FORMATS:
        raise store.StoreError("Formato de exportación desconocido.")
    images = _images(pages)
    name = safe_name(title)
    if kind == "pdf":
        flat = [_flatten(image) for image in images]
        out = io.BytesIO()
        flat[0].save(out, "PDF", save_all=True, append_images=flat[1:], resolution=float(dpi), title=title)
        return out.getvalue(), f"{name}.pdf", FORMATS["pdf"][0]
    if len(images) == 1:
        return _encode(images[0], kind, dpi), f"{name}.{kind}", FORMATS[kind][0]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for number, image in enumerate(images, start=1):
            archive.writestr(f"{name} - página {number}.{kind}", _encode(image, kind, dpi))
    return out.getvalue(), f"{name}.zip", "application/zip"
