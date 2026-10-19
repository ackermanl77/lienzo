"""Plantillas incorporadas.

Cada plantilla se describe en proporciones de la página (0..1) para que sirva
en cualquier tamaño: ``build(width, height)`` devuelve una página lista para
``model.sanitize_page``. Los tamaños de letra son fracciones del lado corto.
La altura de los textos es aproximada: el editor la recalcula al abrirlos.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from . import model


class _Page:
    def __init__(self, width: int, height: int, background: str) -> None:
        self.w, self.h, self.s = width, height, min(width, height)
        self.page: Dict[str, Any] = {"background": {"color": background}, "elements": []}

    def _box(self, x: float, y: float, w: float, h: float) -> Dict[str, float]:
        return {"left": x * self.w, "top": y * self.h, "width": w * self.w, "height": h * self.h}

    def rect(self, x, y, w, h, color, radius=0.0, **extra) -> "_Page":
        self.page["elements"].append({"type": "rect", **self._box(x, y, w, h), "fill": {"color": color},
                                      "radius": radius * self.s, **extra})
        return self

    def shape(self, kind, x, y, w, h, color, square=False, **extra) -> "_Page":
        box = self._box(x, y, w, h)
        if square:  # misma medida en los dos lados (círculos, estrellas)
            side = min(box["width"], box["height"])
            box.update(width=side, height=side)
        self.page["elements"].append({"type": "shape", "kind": kind, **box, "fill": {"color": color}, **extra})
        return self

    def text(self, text, x, y, w, size, color, font="Arial", bold=False, italic=False, align="center",
             line_height=1.15) -> "_Page":
        font_size = size * self.s
        lines = text.count("\n") + 1
        self.page["elements"].append({
            "type": "text", "text": text, "left": x * self.w, "top": y * self.h, "width": w * self.w,
            "height": font_size * line_height * lines, "fontFamily": font, "fontSize": font_size,
            "bold": bold, "italic": italic, "color": color, "align": align, "lineHeight": line_height,
        })
        return self


def _sale(w, h):
    return (_Page(w, h, "#ffd23f")
            .shape("ellipse", 0.55, 0.55, 0.75, 0.75, "#ff6b35", square=True)
            .shape("ellipse", -0.15, -0.12, 0.4, 0.4, "#ffffff", square=True, transparency=0.6)
            .text("OFERTA\nESPECIAL", 0.08, 0.2, 0.84, 0.15, "#1d1d1f", font="Impact", line_height=1.0)
            .text("50% de descuento en toda la tienda", 0.1, 0.52, 0.8, 0.055, "#1d1d1f", bold=True)
            .rect(0.3, 0.68, 0.4, 0.09, "#1d1d1f", radius=0.05)
            .text("Compra ahora", 0.3, 0.70, 0.4, 0.04, "#ffffff", bold=True).page)


def _quote(w, h):
    return (_Page(w, h, "#1d3557")
            .text("“", 0.08, 0.08, 0.3, 0.3, "#e63946", font="Georgia", bold=True, align="left")
            .text("La creatividad es la inteligencia divirtiéndose.", 0.12, 0.34, 0.76, 0.075, "#f1faee",
                  font="Georgia", italic=True, align="left", line_height=1.25)
            .rect(0.12, 0.72, 0.12, 0.006, "#e63946")
            .text("ALBERT EINSTEIN", 0.12, 0.75, 0.7, 0.035, "#a8dadc", bold=True, align="left").page)


def _event(w, h):
    return (_Page(w, h, "#f1faee")
            .rect(0, 0, 1, 0.32, "#e63946")
            .text("TE INVITAMOS A LA", 0.1, 0.1, 0.8, 0.04, "#ffffff", bold=True)
            .text("Gran\ninauguración", 0.06, 0.37, 0.88, 0.1, "#1d3557", font="Georgia", bold=True,
                  line_height=1.05)
            .text("Sábado 14 de marzo · 7:00 p. m.", 0.1, 0.63, 0.8, 0.042, "#457b9d")
            .text("Av. Principal 123, Centro", 0.1, 0.70, 0.8, 0.038, "#1d3557")
            .shape("star", 0.44, 0.82, 0.12, 0.12, "#e63946", square=True).page)


def _minimal(w, h):
    return (_Page(w, h, "#ffffff")
            .rect(0.1, 0.26, 0.08, 0.008, "#111111")
            .text("Título del\nproyecto", 0.1, 0.3, 0.8, 0.1, "#111111", font="Segoe UI", bold=True,
                  align="left", line_height=1.05)
            .text("Un subtítulo breve que explica de qué se trata.", 0.1, 0.56, 0.7, 0.045, "#555555",
                  font="Segoe UI", align="left", line_height=1.3)
            .text("lienzo.local · 2026", 0.1, 0.86, 0.8, 0.03, "#888888", font="Segoe UI", align="left").page)


def _thanks(w, h):
    return (_Page(w, h, "#fde2e4")
            .shape("heart", 0.38, 0.12, 0.24, 0.24, "#e5989b", square=True)
            .text("¡Gracias!", 0.05, 0.42, 0.9, 0.16, "#6d2e46", font="Segoe Script")
            .text("por ser parte de esta historia", 0.1, 0.66, 0.8, 0.05, "#6d2e46", font="Georgia",
                  italic=True)
            .shape("ellipse", 0.08, 0.82, 0.06, 0.06, "#e5989b", square=True)
            .shape("ellipse", 0.86, 0.1, 0.05, 0.05, "#b5838d", square=True).page)


def _menu(w, h):
    items = "\n".join(("Sopa del día ....... $45", "Ensalada .......... $60",
                       "Pasta al pesto .... $95", "Postre ............ $40"))
    return (_Page(w, h, "#fefae0")
            .text("MENÚ DEL DÍA", 0.08, 0.08, 0.84, 0.09, "#283618", font="Georgia", bold=True)
            .rect(0.35, 0.21, 0.3, 0.006, "#bc6c25")
            .text(items, 0.12, 0.3, 0.76, 0.04, "#283618", font="Courier New", align="center", line_height=1.8)
            .text("¡Buen provecho!", 0.1, 0.84, 0.8, 0.05, "#bc6c25", font="Segoe Script").page)


def _bold(w, h):
    return (_Page(w, h, "#111111")
            .shape("triangle", 0.7, -0.05, 0.38, 0.3, "#f9c80e")
            .shape("triangle", -0.08, 0.78, 0.36, 0.3, "#f86624", rotation=180)
            .text("NUEVO\nLANZAMIENTO", 0.08, 0.3, 0.84, 0.105, "#f9c80e", font="Impact", align="left",
                  line_height=1.0)
            .text("Descubre la colección de temporada.", 0.08, 0.58, 0.7, 0.045, "#ffffff", align="left")
            .page)


def _birthday(w, h):
    page = _Page(w, h, "#cdb4db")
    for i, (x, y, color) in enumerate(((0.1, 0.1, "#ffafcc"), (0.8, 0.15, "#a2d2ff"), (0.15, 0.78, "#bde0fe"),
                                       (0.82, 0.8, "#ffc8dd"), (0.5, 0.06, "#ffffff"))):
        page.shape("ellipse" if i % 2 else "star", x, y, 0.08, 0.08, color, square=True)
    return (page.text("¡Feliz\ncumpleaños!", 0.08, 0.26, 0.84, 0.12, "#3a0ca3", font="Segoe Script",
                      line_height=1.25)
            .text("Que todos tus deseos se hagan realidad", 0.1, 0.68, 0.8, 0.042, "#3a0ca3", italic=True)
            .page)


TEMPLATES: List[tuple] = [
    ("sale", "Oferta especial", "Ventas", _sale),
    ("quote", "Cita inspiradora", "Frases", _quote),
    ("event", "Invitación a evento", "Eventos", _event),
    ("minimal", "Portada minimalista", "Negocios", _minimal),
    ("thanks", "Agradecimiento", "Tarjetas", _thanks),
    ("menu", "Menú del día", "Comida", _menu),
    ("bold", "Anuncio audaz", "Ventas", _bold),
    ("birthday", "Cumpleaños", "Tarjetas", _birthday),
]
_BY_ID: Dict[str, Callable] = {key: build for key, _name, _cat, build in TEMPLATES}


# ---------------- diseño mágico (textos y colores de la IA) ----------------
def _hex(value: Any, default: str) -> str:
    return value.lower() if isinstance(value, str) and model._COLOR_RE.match(value) else default


def _luminance(color: str) -> float:
    def channel(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _readable(text: str, background: str) -> str:
    """El color de texto propuesto, o blanco/negro si no se lee bien sobre el fondo."""
    if contrast(text, background) >= 4.5:
        return text
    return "#ffffff" if contrast("#ffffff", background) >= contrast("#111111", background) else "#111111"


def _short(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def magic_page(width: int, height: int, data: Dict[str, Any]) -> Dict[str, Any]:
    """Una página armada con los textos y colores que propuso la IA."""
    width, height = model.check_size(width, height)
    bg = _hex(data.get("background"), "#1d3557")
    accent = _hex(data.get("accent"), "#e63946")
    text = _readable(_hex(data.get("text"), "#ffffff"), bg)
    on_accent = _readable("#ffffff", accent)
    title = _short(data.get("title"), 80) or "Tu título aquí"
    subtitle = _short(data.get("subtitle"), 160)
    body = _short(data.get("body"), 300)
    cta = _short(data.get("cta"), 30)
    style = data.get("style") if data.get("style") in ("audaz", "elegante", "minimalista", "divertido") else "audaz"
    page = _Page(width, height, bg)
    if style == "audaz":
        page.shape("triangle", 0.62, -0.08, 0.5, 0.42, accent).shape("ellipse", -0.12, 0.78, 0.35, 0.35, accent,
                                                                       square=True, transparency=0.4)
        page.text(title.upper(), 0.08, 0.2, 0.84, 0.11, text, font="Impact", align="left", line_height=1.0)
        y = 0.5
        align, font = "left", "Arial"
    elif style == "elegante":
        page.rect(0.06, 0.06, 0.88, 0.88, bg, stroke={"color": accent, "width": 0.006 * min(width, height)})
        page.text(title, 0.12, 0.24, 0.76, 0.095, text, font="Georgia", italic=True, line_height=1.15)
        page.rect(0.42, 0.5, 0.16, 0.004, accent)
        y = 0.54
        align, font = "center", "Georgia"
    elif style == "minimalista":
        page.rect(0.1, 0.22, 0.1, 0.01, accent)
        page.text(title, 0.1, 0.26, 0.8, 0.09, text, font="Segoe UI", bold=True, align="left", line_height=1.1)
        y = 0.52
        align, font = "left", "Segoe UI"
    else:
        for x, yy, size in ((0.08, 0.08, 0.1), (0.8, 0.12, 0.07), (0.86, 0.78, 0.11), (0.1, 0.82, 0.06)):
            page.shape("ellipse", x, yy, size, size, accent, square=True, transparency=0.25)
        page.shape("star", 0.46, 0.06, 0.08, 0.08, accent, square=True)
        page.text(title, 0.08, 0.22, 0.84, 0.1, text, font="Segoe Script", line_height=1.2)
        y = 0.52
        align, font = "center", "Comic Sans MS"
    if subtitle:
        page.text(subtitle, 0.1, y, 0.8, 0.045, text, font=font, bold=style != "elegante", align=align,
                  line_height=1.25)
        y += 0.1
    if body:
        page.text(body, 0.1, y, 0.8, 0.032, text, font=font, align=align, line_height=1.35)
        y += 0.12
    if cta:
        x = 0.1 if align == "left" else 0.3
        page.rect(x, min(y + 0.02, 0.84), 0.4, 0.08, accent, radius=0.04)
        page.text(cta, x, min(y + 0.02, 0.84) + 0.018, 0.4, 0.038, on_accent, font=font, bold=True)
    return model.sanitize_page(page.page, width, height)


def template_page(template_id: str, width: int, height: int) -> Dict[str, Any]:
    build = _BY_ID.get(template_id)
    if build is None:
        raise model.DesignError("Plantilla desconocida.")
    return model.sanitize_page(build(width, height), width, height)


def templates_for(width: int, height: int) -> List[Dict[str, Any]]:
    width, height = model.check_size(width, height)
    return [{"id": key, "nombre": name, "categoria": cat, "pagina": template_page(key, width, height)}
            for key, name, cat, _build in TEMPLATES]
