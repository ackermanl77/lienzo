"""Fotos de stock con licencia Creative Commons desde Openverse
(https://openverse.org, sin clave de API; necesita internet).

La búsqueda pasa por este servidor y se filtra a licencias que permiten uso
comercial y modificación. Para importar, el servidor vuelve a pedir el detalle
de la imagen a Openverse (no confía en una URL que mande la página), la
descarga con ``net.fetch`` y la guarda en "Subidos" con su crédito.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List
from urllib.parse import urlencode

from . import net, store

API = "https://api.openverse.org/v1/images/"
_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _get_json(url: str) -> Dict[str, Any]:
    try:
        data = json.loads(net.fetch(url, 3_000_000, ("api.openverse.org",), timeout=20))
    except net.NetError as exc:
        raise store.StoreError(str(exc)) from None
    except ValueError:
        raise store.StoreError("Openverse devolvió una respuesta inválida.") from None
    if not isinstance(data, dict):
        raise store.StoreError("Openverse devolvió una respuesta inválida.")
    return data


def _credit(item: Dict[str, Any]) -> Dict[str, str]:
    license_name = f"CC {str(item.get('license', '')).upper()} {item.get('license_version') or ''}".strip()
    if item.get("license") in ("cc0", "pdm"):
        license_name = "Dominio público" if item.get("license") == "pdm" else "CC0"
    return {
        "title": str(item.get("title") or "Sin título")[:200],
        "creator": str(item.get("creator") or "Autor desconocido")[:200],
        "license": license_name,
        "license_url": str(item.get("license_url") or "")[:300],
        "source_url": str(item.get("foreign_landing_url") or "")[:300],
        "text": str(item.get("attribution") or "")[:600],
    }


def search(query: str, page: int = 1) -> Dict[str, Any]:
    query = " ".join(str(query or "").split())[:100]
    if not query:
        raise store.StoreError("Escribe qué buscar.")
    page = max(1, min(int(page or 1), 20))
    # Sin clave de API, Openverse admite como máximo 20 resultados por página (más responde 401).
    params = urlencode({"q": query, "page": page, "page_size": 20, "license_type": "commercial,modification",
                        "mature": "false"})
    data = _get_json(f"{API}?{params}")
    results: List[Dict[str, Any]] = []
    for item in data.get("results", []):
        if not isinstance(item, dict) or not _ID_RE.match(str(item.get("id", ""))):
            continue
        results.append({"id": item["id"], "thumb": f"{API}{item['id']}/thumb/",
                        "width": item.get("width"), "height": item.get("height"), "credit": _credit(item)})
    return {"results": results, "page": page, "pages": min(int(data.get("page_count") or 1), 20)}


def import_image(image_id: str) -> Dict[str, Any]:
    if not _ID_RE.match(str(image_id or "")):
        raise store.StoreError("Imagen de Openverse inválida.")
    item = _get_json(f"{API}{image_id}/")
    url = item.get("url")
    if not isinstance(url, str):
        raise store.StoreError("Openverse no tiene el archivo de esa imagen.")
    try:
        data = net.fetch(url, store.MAX_ASSET_BYTES, timeout=40)
    except net.NetError as exc:
        raise store.StoreError(f"No se pudo descargar la foto: {exc}") from None
    return store.add_asset(data, f"{_credit(item)['title']}.jpg", credit=_credit(item))
