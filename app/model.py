"""El modelo de un diseño de Lienzo y su validación.

La forma sigue lo que la documentación pública de Canva describe para sus
diseños (ver docs/EVIDENCIA.md):

- un diseño tiene un tamaño fijo y una o más páginas "absolutas";
- cada página tiene un fondo (color o imagen) y una lista de elementos, del
  fondo hacia el frente;
- los elementos comparten ``left``, ``top``, ``width``, ``height``,
  ``rotation``, ``transparency`` y ``locked``;
- tipos: ``rect`` (un rectángulo cuyo *relleno* es un color, una imagen o un
  video: no hay un tipo "imagen" aparte), ``shape`` (formas vectoriales),
  ``text``, ``table`` (tablas) y ``graphic`` (gráficos de la galería
  incorporada);
- los elementos agrupados comparten ``group`` (un id); cada elemento puede
  tener una animación de entrada y cada página una duración (para video);
- un tamaño propio va de 40 a 8000 px por lado y como máximo 25 millones de
  píxeles de área.

``sanitize_design`` es la única puerta de entrada al disco: limita números,
quita lo desconocido y rechaza lo que no se puede arreglar.
"""

from __future__ import annotations

import re
import time
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional

MIN_SIDE = 40
MAX_SIDE = 8000
MAX_AREA = 25_000_000
MAX_PAGES = 100
MAX_ELEMENTS = 500
MAX_TEXT = 5000
MAX_TITLE = 120

ELEMENT_TYPES = ("rect", "shape", "text", "table", "graphic", "draw")
MAX_DRAW_POINTS = 2000  # web/js/model.js MAX_DRAW_POINTS
SHAPE_KINDS = ("ellipse", "triangle", "star", "hexagon", "diamond", "arrow", "line", "heart")
FONTS = (
    "Arial", "Georgia", "Times New Roman", "Verdana", "Trebuchet MS", "Segoe UI", "Bahnschrift",
    "Impact", "Courier New", "Comic Sans MS", "Segoe Script", "Palatino Linotype", "Tahoma", "Cambria",
)
ALIGNS = ("left", "center", "right")
ANIMATIONS = ("none", "fade", "rise", "slide_left", "slide_right", "pop", "zoom_out", "drop", "spin", "typewriter")
MAX_TABLE_ROWS = 40
MAX_TABLE_COLS = 12
MAX_CELL_TEXT = 1000
PAGE_DURATION = 5.0

# Formatos de inicio: clave -> (nombre, ancho, alto, categoría, ppp para el PDF).
FORMATS: Dict[str, tuple] = {
    "instagram_post": ("Publicación de Instagram", 1080, 1080, "Redes sociales", 96),
    "instagram_story": ("Historia de Instagram", 1080, 1920, "Redes sociales", 96),
    "facebook_post": ("Publicación de Facebook", 1200, 630, "Redes sociales", 96),
    "facebook_cover": ("Portada de Facebook", 1640, 624, "Redes sociales", 96),
    "youtube_thumbnail": ("Miniatura de YouTube", 1280, 720, "Video", 96),
    "presentation": ("Presentación (16:9)", 1920, 1080, "Presentaciones", 96),
    "poster": ("Póster (A3)", 3508, 4961, "Impresos", 300),
    "a4_document": ("Documento A4", 2480, 3508, "Impresos", 300),
    "flyer": ("Volante (carta)", 2550, 3300, "Impresos", 300),
    "business_card": ("Tarjeta de presentación", 1050, 600, "Impresos", 300),
    "invitation": ("Invitación (5 × 7 in)", 1500, 2100, "Impresos", 300),
    "logo": ("Logo", 500, 500, "Marca", 96),
}

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_DESIGN_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_ASSET_ID_RE = re.compile(r"^[0-9a-f]{16}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 \-]{0,59}$")
_GRAPHIC_RE = re.compile(r"^[a-z0-9-]{1,40}$")


class DesignError(ValueError):
    """Un diseño que no se puede guardar (el mensaje es para el usuario)."""


def new_id(length: int = 12) -> str:
    return uuid.uuid4().hex[:length]


def is_design_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_DESIGN_ID_RE.match(value))


def is_asset_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_ASSET_ID_RE.match(value))


def check_size(width: Any, height: Any) -> tuple:
    """El tamaño validado (enteros) o DesignError."""
    try:
        if isinstance(width, bool) or isinstance(height, bool):
            raise ValueError
        numeric_width, numeric_height = Decimal(str(width)), Decimal(str(height))
        if not (numeric_width.is_finite() and numeric_height.is_finite()
                and numeric_width == numeric_width.to_integral_value()
                and numeric_height == numeric_height.to_integral_value()):
            raise ValueError
    except (InvalidOperation, OverflowError, TypeError, ValueError):
        raise DesignError("El tamaño debe ser un número entero y finito de píxeles.") from None
    if not (MIN_SIDE <= numeric_width <= MAX_SIDE and MIN_SIDE <= numeric_height <= MAX_SIDE):
        raise DesignError(f"Cada lado debe medir entre {MIN_SIDE} y {MAX_SIDE} px.")
    w, h = int(numeric_width), int(numeric_height)
    if w * h > MAX_AREA:
        raise DesignError("El diseño es demasiado grande (máximo 25 millones de píxeles).")
    return w, h


def _num(value: Any, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return default
    return float(min(high, max(low, value)))


def _color(value: Any, default: str) -> str:
    return value.lower() if isinstance(value, str) and _COLOR_RE.match(value) else default


def _text(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _stroke(value: Any) -> Dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    return {"color": _color(value.get("color"), "#1f2933"), "width": _num(value.get("width"), 0, 0, 200)}


def _fill(value: Any, default: str) -> Dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    fill: Dict[str, Any] = {"color": _color(value.get("color"), default) if value.get("color") != "" else ""}
    if is_asset_id(value.get("video")):
        fill["video"] = value["video"]
    elif is_asset_id(value.get("image")):
        fill["image"] = value["image"]
    return fill


def _font(value: Any) -> str:
    """Una fuente incorporada o cualquier nombre válido (fuentes descargadas o subidas)."""
    return value if isinstance(value, str) and (value in FONTS or _FONT_RE.match(value)) else "Arial"


MAX_BRAND_COLORS = 24
MAX_BRAND_FONTS = 12


def sanitize_brand(raw: Any) -> Dict[str, Any]:
    """El kit de marca (UI4) limpio: colores #rrggbb sin repetir, fuentes válidas sin repetir y un
    logo que es una imagen subida (o ninguno)."""
    raw = raw if isinstance(raw, dict) else {}
    colors: List[str] = []
    for value in raw.get("colores") if isinstance(raw.get("colores"), list) else []:
        if isinstance(value, str) and _COLOR_RE.match(value) and value.lower() not in colors:
            colors.append(value.lower())
    fonts: List[str] = []
    for value in raw.get("fuentes") if isinstance(raw.get("fuentes"), list) else []:
        if isinstance(value, str) and (value in FONTS or _FONT_RE.match(value)) and value not in fonts:
            fonts.append(value)
    logo = raw.get("logo") if isinstance(raw.get("logo"), str) and _ASSET_ID_RE.match(raw["logo"]) else None
    return {"colores": colors[:MAX_BRAND_COLORS], "fuentes": fonts[:MAX_BRAND_FONTS], "logo": logo}


def _animation(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict) or value.get("type") not in ANIMATIONS or value.get("type") == "none":
        return None
    return {"type": value["type"], "delay": _num(value.get("delay"), 0, 0, 60),
            "duration": _num(value.get("duration"), 0.8, 0.1, 20)}


def _table(raw: Dict[str, Any], el: Dict[str, Any]) -> None:
    cells = raw.get("cells") if isinstance(raw.get("cells"), list) else []
    rows = int(_num(raw.get("rows"), max(1, len(cells)), 1, MAX_TABLE_ROWS))
    cols = int(_num(raw.get("cols"), 3, 1, MAX_TABLE_COLS))
    grid = []
    for r in range(rows):
        row = cells[r] if r < len(cells) and isinstance(cells[r], list) else []
        grid.append([_text(row[c], MAX_CELL_TEXT) if c < len(row) else "" for c in range(cols)])
    widths = raw.get("colWidths") if isinstance(raw.get("colWidths"), list) else []
    widths = [_num(w, 1, 0.02, 100) for w in widths[:cols]] + [1.0] * max(0, cols - len(widths))
    total = sum(widths)
    el.update({
        "rows": rows, "cols": cols, "cells": grid, "colWidths": [w / total for w in widths],
        "fontFamily": _font(raw.get("fontFamily")), "fontSize": _num(raw.get("fontSize"), 28, 4, 400),
        "color": _color(raw.get("color"), "#1f2933"),
        "align": raw.get("align") if raw.get("align") in ALIGNS else "left",
        "header": raw.get("header") is not False, "headerFill": _color(raw.get("headerFill"), "#6c3cf0"),
        "headerColor": _color(raw.get("headerColor"), "#ffffff"), "cellFill": _color(raw.get("cellFill"), "#ffffff"),
        "stripe": raw.get("stripe") is True, "borderColor": _color(raw.get("borderColor"), "#d9d6e8"),
        "borderWidth": _num(raw.get("borderWidth"), 2, 0, 40), "lineHeight": _num(raw.get("lineHeight"), 1.25, 0.8, 3),
    })


def sanitize_element(raw: Any, width: int, height: int) -> Optional[Dict[str, Any]]:
    """Un elemento limpio, o None si no se puede usar."""
    if not isinstance(raw, dict) or raw.get("type") not in ELEMENT_TYPES:
        return None
    span = 4 * max(width, height)
    el: Dict[str, Any] = {
        "id": raw["id"] if isinstance(raw.get("id"), str) and _ID_RE.match(raw["id"]) else new_id(8),
        "type": raw["type"],
        "left": _num(raw.get("left"), 0, -span, span),
        "top": _num(raw.get("top"), 0, -span, span),
        "width": _num(raw.get("width"), 100, 1, span),
        "height": _num(raw.get("height"), 100, 1, span),
        "rotation": _num(raw.get("rotation"), 0, -360, 360),
        "transparency": _num(raw.get("transparency"), 0, 0, 1),
        "locked": raw.get("locked") is True,
    }
    if isinstance(raw.get("group"), str) and _ID_RE.match(raw["group"]):
        el["group"] = raw["group"]
    animation = _animation(raw.get("animation"))
    if animation:
        el["animation"] = animation
    if el["type"] == "rect":
        el["fill"] = _fill(raw.get("fill"), "#7d5fff")
        el["radius"] = _num(raw.get("radius"), 0, 0, span)
        el["stroke"] = _stroke(raw.get("stroke"))
    elif el["type"] == "shape":
        el["kind"] = raw.get("kind") if raw.get("kind") in SHAPE_KINDS else "ellipse"
        el["fill"] = _fill(raw.get("fill"), "#7d5fff")
        el["stroke"] = _stroke(raw.get("stroke"))
    elif el["type"] == "table":
        _table(raw, el)
    elif el["type"] == "draw":
        # UI4: a freehand stroke -- its points as fractions of the element's box.
        points = raw.get("points") if isinstance(raw.get("points"), list) else []
        el["points"] = [[_num(p[0], 0, 0, 1), _num(p[1], 0, 0, 1)] for p in points[:MAX_DRAW_POINTS]
                        if isinstance(p, (list, tuple)) and len(p) == 2]
        if len(el["points"]) < 2:
            return None
        stroke = raw.get("stroke") if isinstance(raw.get("stroke"), dict) else {}
        el["stroke"] = {"color": _color(stroke.get("color"), "#1f2933"), "width": _num(stroke.get("width"), 6, 0.5, 200)}
    elif el["type"] == "graphic":
        el["name"] = raw["name"] if isinstance(raw.get("name"), str) and _GRAPHIC_RE.match(raw["name"]) else "star"
        el["fill"] = _fill(raw.get("fill"), "#6c3cf0")
        el["fill"].pop("image", None)
        el["fill"].pop("video", None)
    else:
        el["text"] = _text(raw.get("text"), MAX_TEXT)
        el["fontFamily"] = _font(raw.get("fontFamily"))
        el["fontSize"] = _num(raw.get("fontSize"), 48, 4, 1000)
        el["bold"] = raw.get("bold") is True
        el["italic"] = raw.get("italic") is True
        el["underline"] = raw.get("underline") is True
        el["color"] = _color(raw.get("color"), "#1f2933")
        el["align"] = raw.get("align") if raw.get("align") in ALIGNS else "left"
        el["lineHeight"] = _num(raw.get("lineHeight"), 1.2, 0.8, 3)
    return el


def sanitize_page(raw: Any, width: int, height: int) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    background = raw.get("background") if isinstance(raw.get("background"), dict) else {}
    page_bg: Dict[str, Any] = {"color": _color(background.get("color"), "#ffffff")}
    if is_asset_id(background.get("image")):
        page_bg["image"] = background["image"]
    elements: List[Dict[str, Any]] = []
    seen = set()
    for item in raw.get("elements", [])[:MAX_ELEMENTS] if isinstance(raw.get("elements"), list) else []:
        el = sanitize_element(item, width, height)
        if el is None:
            continue
        if el["id"] in seen:
            el["id"] = new_id(8)
        seen.add(el["id"])
        elements.append(el)
    page_id = raw.get("id") if isinstance(raw.get("id"), str) and _ID_RE.match(raw["id"]) else new_id(8)
    return {"id": page_id, "background": page_bg, "elements": elements,
            "duration": _num(raw.get("duration"), PAGE_DURATION, 0.5, 120)}


def sanitize_design(raw: Any) -> Dict[str, Any]:
    """El diseño listo para guardar. Lanza DesignError si no tiene arreglo."""
    if not isinstance(raw, dict):
        raise DesignError("Diseño inválido.")
    width, height = check_size(raw.get("width"), raw.get("height"))
    pages = raw.get("pages")
    if not isinstance(pages, list) or not pages:
        raise DesignError("El diseño necesita al menos una página.")
    if len(pages) > MAX_PAGES:
        raise DesignError(f"Un diseño puede tener como máximo {MAX_PAGES} páginas.")
    clean_pages = [sanitize_page(page, width, height) for page in pages]
    ids = set()
    for page in clean_pages:
        if page["id"] in ids:
            page["id"] = new_id(8)
        ids.add(page["id"])
    fmt = raw.get("format") if raw.get("format") in FORMATS else "custom"
    title = " ".join(_text(raw.get("title"), MAX_TITLE).split()) or "Diseño sin título"
    now = time.time()
    return {
        "version": 1,
        "id": raw["id"] if is_design_id(raw.get("id")) else new_id(),
        "title": title,
        "format": fmt,
        "width": width,
        "height": height,
        "pages": clean_pages,
        "created": _num(raw.get("created"), now, 0, 1e11),
        "updated": now,
    }


def dpi_for(design: Dict[str, Any]) -> int:
    fmt = FORMATS.get(design.get("format", ""))
    return fmt[4] if fmt else 96


def new_design(width: int, height: int, title: str = "", fmt: str = "custom",
               pages: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    if fmt in FORMATS and not title:
        title = FORMATS[fmt][0]
    return sanitize_design({
        "id": new_id(), "title": title, "format": fmt, "width": width, "height": height,
        "pages": pages or [{"background": {"color": "#ffffff"}, "elements": []}],
    })


def formats() -> List[Dict[str, Any]]:
    return [{"id": key, "nombre": name, "ancho": w, "alto": h, "categoria": cat}
            for key, (name, w, h, cat, _dpi) in FORMATS.items()]
