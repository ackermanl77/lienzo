"""Fuentes descargables: Google Fonts (licencias libres, OFL/Apache) o archivos
propios (.ttf, .otf, .woff, .woff2). Quedan en ``data_dir()/fonts`` y se usan
sin internet; la página las registra con la API FontFace.

Google Fonts entrega archivos TTF completos (sin subconjuntos) cuando el
pedido no viene de un navegador moderno, así que basta con leer las URL del
CSS que devuelve ``fonts.googleapis.com/css2``.
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from . import model, net, paths
from .store import StoreError, atomic_write

GOOGLE_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")
MAX_FONT_BYTES = 15 * 1024 * 1024
MAGIC = {b"\x00\x01\x00\x00": "ttf", b"true": "ttf", b"OTTO": "otf", b"wOFF": "woff", b"wOF2": "woff2"}
MIME = {"ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2"}

# Una selección de familias populares de Google Fonts (se puede escribir cualquier otra).
CATALOG = (
    "Roboto", "Open Sans", "Montserrat", "Lato", "Poppins", "Inter", "Oswald", "Raleway", "Nunito", "Rubik",
    "Work Sans", "Merriweather", "Playfair Display", "Lora", "PT Serif", "Libre Baskerville", "DM Serif Display",
    "Cormorant Garamond", "EB Garamond", "Crimson Text", "Bebas Neue", "Anton", "Archivo Black", "Alfa Slab One",
    "Abril Fatface", "Righteous", "Bungee", "Black Ops One", "Russo One", "Teko", "Barlow Condensed",
    "Fjalla One", "Josefin Sans", "Quicksand", "Comfortaa", "Fredoka", "Baloo 2", "Varela Round", "Kanit",
    "Space Grotesk", "Sora", "Outfit", "Manrope", "Urbanist", "Lexend", "Archivo", "Karla", "Mulish",
    "Pacifico", "Lobster", "Dancing Script", "Great Vibes", "Satisfy", "Caveat", "Shadows Into Light",
    "Indie Flower", "Amatic SC", "Permanent Marker", "Kaushan Script", "Sacramento", "Allura", "Parisienne",
    "Yellowtail", "Courgette", "Cookie", "Gloria Hallelujah", "Patrick Hand", "Architects Daughter",
    "Special Elite", "Press Start 2P", "VT323", "Monoton", "Bangers", "Luckiest Guy", "Creepster",
    "Cinzel", "Cinzel Decorative", "Orbitron", "Audiowide", "Space Mono", "Source Code Pro", "JetBrains Mono",
)

_lock = threading.Lock()
_SRC_RE = re.compile(
    r"font-style:\s*(normal|italic);\s*font-weight:\s*(\d+);.*?src:\s*url\((https://fonts\.gstatic\.com/[^)\s]+)\)",
    re.S)


def _dir() -> str:
    folder = os.path.join(paths.data_dir(), "fonts")
    os.makedirs(folder, exist_ok=True)
    return folder


def _index() -> Dict[str, Any]:
    try:
        with open(os.path.join(_dir(), "index.json"), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_index(index: Dict[str, Any]) -> None:
    atomic_write(os.path.join(_dir(), "index.json"), json.dumps(index, ensure_ascii=False, indent=1).encode())


def font_kind(data: bytes) -> Optional[str]:
    return MAGIC.get(data[:4])


def clean_family(name: Any) -> str:
    family = " ".join(str(name or "").split())[:60]
    if not model._FONT_RE.match(family):
        raise StoreError("Nombre de fuente inválido (solo letras, números, espacios y guiones).")
    if family in model.FONTS:
        raise StoreError("Esa fuente ya viene incluida.")
    return family


def _slug(family: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", family.lower()).strip("-")


def _add_file(index: Dict[str, Any], family: str, data: bytes, style: str, weight: int, source: str) -> None:
    kind = font_kind(data)
    if kind is None:
        raise StoreError("El archivo no es una fuente (.ttf, .otf, .woff o .woff2).")
    name = f"{_slug(family)}-{style}-{weight}.{kind}"
    atomic_write(os.path.join(_dir(), name), data)
    entry = index.setdefault(family, {"source": source, "files": []})
    files = [f for f in entry["files"] if f["file"] != name]
    entry["files"] = files + [{"file": name, "style": style, "weight": weight}]


def install_google(name: Any) -> Dict[str, Any]:
    """Descarga una familia de Google Fonts (normal, negrita y cursivas si existen)."""
    family = clean_family(name)
    base = "https://fonts.googleapis.com/css2?family=" + quote(family).replace("%20", "+")
    css = None
    for suffix in (":ital,wght@0,400;0,700;1,400;1,700", ":wght@400;700", ""):
        try:
            css = net.fetch(base + suffix, 200_000, GOOGLE_HOSTS).decode("utf-8", "replace")
            break
        except net.NetError as exc:
            if "error 400" not in str(exc):
                raise StoreError(str(exc)) from None
    if not css:
        raise StoreError(f"Google Fonts no tiene una fuente llamada «{family}».")
    faces = _SRC_RE.findall(css)
    if not faces:
        raise StoreError(f"Google Fonts no devolvió archivos para «{family}».")
    with _lock:
        index = _index()
        index.pop(family, None)
        for style, weight, url in faces:
            try:
                data = net.fetch(url, MAX_FONT_BYTES, GOOGLE_HOSTS)
            except net.NetError as exc:
                raise StoreError(str(exc)) from None
            _add_file(index, family, data, style, int(weight), "google")
        _save_index(index)
    return view(family, index[family])


def install_file(data: bytes, family: Any, filename: str = "") -> Dict[str, Any]:
    """Instala un archivo de fuente propio; negrita/cursiva según el nombre del archivo."""
    if len(data) > MAX_FONT_BYTES:
        raise StoreError("La fuente pesa más de 15 MB.")
    name = os.path.splitext(os.path.basename(filename or ""))[0]
    family = clean_family(family or re.sub(r"[-_ ]?(regular|bold|italic|bolditalic)$", "", name, flags=re.I) or name)
    lower = name.lower()
    style = "italic" if "italic" in lower or lower.endswith("-it") else "normal"
    weight = 700 if "bold" in lower else 400
    with _lock:
        index = _index()
        _add_file(index, family, data, style, weight, "archivo")
        _save_index(index)
    return view(family, index[family])


def view(family: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    return {"family": family, "source": entry.get("source", ""),
            "files": [{"url": f"/fonts/{f['file']}", "style": f["style"], "weight": f["weight"]}
                      for f in entry.get("files", [])]}


def installed() -> List[Dict[str, Any]]:
    index = _index()
    return [view(family, entry) for family, entry in sorted(index.items()) if isinstance(entry, dict)]


def remove(family: str) -> bool:
    with _lock:
        index = _index()
        entry = index.pop(family, None)
        if entry is None:
            return False
        for f in entry.get("files", []):
            path = os.path.join(_dir(), f["file"])
            if os.path.exists(path):
                os.remove(path)
        _save_index(index)
    return True


def font_file(name: str) -> Optional[tuple]:
    """(ruta, tipo MIME) de un archivo de fuente instalado, o None."""
    if not re.match(r"^[a-z0-9-]+\.(ttf|otf|woff2?)$", name):
        return None
    path = os.path.join(_dir(), name)
    return (path, MIME[name.rsplit(".", 1)[1]]) if os.path.isfile(path) else None
