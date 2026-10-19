"""Quitar un fondo liso (sin modelos de IA): desde los bordes de la imagen se
rellenan los píxeles parecidos al color del borde y se vuelven transparentes,
con un borde suavizado. Funciona bien con fotos de producto, logos y
capturas sobre fondo uniforme; no con fondos complejos (eso necesitaría un
modelo de segmentación).
"""

from __future__ import annotations

import io

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from . import store

MAX_PIXELS = 25_000_000


def remove_plain_background(data: bytes, tolerance: int = 40) -> bytes:
    tolerance = max(1, min(int(tolerance), 160))
    image = Image.open(io.BytesIO(data))
    image.load()
    if image.width * image.height > MAX_PIXELS:
        raise store.StoreError("La imagen es demasiado grande para quitarle el fondo (máximo 25 MP).")
    rgba = image.convert("RGBA")
    rgb = rgba.convert("RGB")
    w, h = rgb.size
    # Marca con un color "imposible" todo lo conectado a los bordes que se parezca a ellos.
    marker = (255, 0, 254)
    probe = rgb.copy()
    seeds = [(x, y) for x in range(0, w, max(1, w // 40)) for y in (0, h - 1)]
    seeds += [(x, y) for y in range(0, h, max(1, h // 40)) for x in (0, w - 1)]
    for seed in seeds:
        if probe.getpixel(seed) != marker:
            ImageDraw.floodfill(probe, seed, marker, thresh=tolerance)
    diff = ImageChops.difference(probe, Image.new("RGB", (w, h), marker)).convert("L")
    background = diff.point(lambda v: 255 if v == 0 else 0)
    share = background.histogram()[255] / (w * h)
    if share == 0:
        raise store.StoreError("No se encontró un fondo liso que quitar.")
    if share > 0.995:
        raise store.StoreError("Toda la imagen parece fondo: no hay nada que recortar (prueba con menos tolerancia).")
    keep = ImageChops.invert(background).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    alpha = ImageChops.multiply(rgba.getchannel("A"), keep)
    rgba.putalpha(alpha)
    out = io.BytesIO()
    rgba.save(out, "PNG", optimize=True)
    return out.getvalue()


def remove_background_asset(asset_id: str, tolerance: int = 40) -> dict:
    meta_name = next((a["name"] for a in store.list_assets() if a["id"] == asset_id), "imagen")
    png = remove_plain_background(store.asset_bytes(asset_id), tolerance)
    base = meta_name.rsplit(".", 1)[0]
    return store.add_asset(png, f"{base} (sin fondo).png")
