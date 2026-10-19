"""Descargas de internet con límites (fuentes de Google y fotos de Openverse).

``fetch`` solo acepta https, limita el tamaño y el tiempo, rechaza nombres que
resuelvan a direcciones privadas o locales (para que una URL recibida de un
servicio externo no pueda apuntar a esta PC o a la red local) y sigue como
máximo unas pocas redirecciones, revisando cada una.
"""

from __future__ import annotations

import ipaddress
import socket
import urllib.error
import urllib.request
from typing import Dict, Optional, Tuple
from urllib.parse import urlsplit

USER_AGENT = "Lienzo/0.2 (local design editor)"  # solo ASCII: Openverse rechaza (403) cabeceras con acentos
MAX_REDIRECTS = 4


class NetError(ValueError):
    """Un problema de red (el mensaje es para el usuario)."""


def _check_public(url: str, hosts: Optional[Tuple[str, ...]]) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise NetError("Solo se permiten descargas https.")
    host = parts.hostname.lower()
    if hosts and not any(host == h or host.endswith("." + h) for h in hosts):
        raise NetError(f"Servidor no permitido: {host}")
    try:
        infos = socket.getaddrinfo(host, parts.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise NetError("No hay conexión a internet (no se encontró el servidor).") from None
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            raise NetError("La dirección apunta a una red privada.")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - lo maneja fetch
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def fetch(url: str, limit: int, hosts: Optional[Tuple[str, ...]] = None, timeout: float = 30,
          headers: Optional[Dict[str, str]] = None) -> bytes:
    """Los bytes de ``url`` (https, público, como mucho ``limit`` bytes)."""
    for _ in range(MAX_REDIRECTS + 1):
        _check_public(url, hosts)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with _opener.open(request, timeout=timeout) as response:
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise NetError("El archivo es demasiado grande.")
                return data
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308) and exc.headers.get("Location"):
                url = urllib.request.urljoin(url, exc.headers["Location"])
                continue
            raise NetError(f"El servidor respondió con el error {exc.code}.") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if isinstance(exc, NetError):
                raise
            raise NetError("No se pudo descargar (sin conexión o el servidor no responde).") from None
    raise NetError("Demasiadas redirecciones.")
