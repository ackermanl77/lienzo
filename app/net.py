"""Descargas de internet con límites (fuentes de Google y fotos de Openverse).

``fetch`` solo acepta https, limita el tamaño y el tiempo, rechaza nombres que
resuelvan a direcciones privadas o locales (para que una URL recibida de un
servicio externo no pueda apuntar a esta PC o a la red local) y sigue como
máximo unas pocas redirecciones, revisando cada una.
"""

from __future__ import annotations

import http.client
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


def _check_public(url: str, hosts: Optional[Tuple[str, ...]]) -> Tuple[str, int, tuple]:
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
    if not infos:
        raise NetError("No hay conexión a internet (no se encontró el servidor).")
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            raise NetError("La dirección apunta a una red privada.")
    return host, parts.port or 443, tuple(infos)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, addresses: tuple, origin_host: str, **kwargs) -> None:
        super().__init__(host, **kwargs)
        self._validated_addresses = addresses
        self._origin_host = origin_host

    def _open_proxy_tunnel(self) -> None:
        original_tunnel_host = self._tunnel_host
        last_error = None
        try:
            for info in self._validated_addresses:
                address = ipaddress.ip_address(info[4][0].split("%")[0])
                self.sock = socket.create_connection((self.host, self.port), self.timeout, self.source_address)
                self._tunnel_host = f"[{address}]" if address.version == 6 else str(address)
                try:
                    self._tunnel()
                    self._has_connected_to_proxy = True
                    return
                except (OSError, http.client.HTTPException) as exc:
                    last_error = exc
                    self.sock.close()
                    self.sock = None
        finally:
            self._tunnel_host = original_tunnel_host
        if last_error:
            raise last_error
        raise OSError("No se pudo abrir el túnel HTTPS.")

    def _open_pinned_socket(self) -> None:
        last_error = None
        for family, socktype, proto, _canonname, sockaddr in self._validated_addresses:
            sock = socket.socket(family, socktype, proto)
            try:
                if self.timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                    sock.settimeout(self.timeout)
                if self.source_address:
                    sock.bind(self.source_address)
                sock.connect(sockaddr)
                self.sock = sock
                return
            except OSError as exc:
                last_error = exc
                sock.close()
        if last_error:
            raise last_error
        raise OSError("No se pudo conectar a una dirección pública.")

    def connect(self) -> None:
        if self._tunnel_host:
            self._open_proxy_tunnel()
        else:
            self._open_pinned_socket()
        try:
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self._origin_host)
        except Exception:
            self.sock.close()
            self.sock = None
            raise


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, addresses: tuple, origin_host: str) -> None:
        super().__init__()
        self._validated_addresses = addresses
        self._origin_host = origin_host

    def https_open(self, request):
        def connection_factory(host, **kwargs):
            return _PinnedHTTPSConnection(
                host, self._validated_addresses, self._origin_host, **kwargs
            )

        return self.do_open(
            connection_factory,
            request,
            context=self._context,
            check_hostname=self._check_hostname,
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - lo maneja fetch
        return None


def fetch(url: str, limit: int, hosts: Optional[Tuple[str, ...]] = None, timeout: float = 30,
          headers: Optional[Dict[str, str]] = None) -> bytes:
    """Los bytes de ``url`` (https, público, como mucho ``limit`` bytes)."""
    for _ in range(MAX_REDIRECTS + 1):
        host, _port, addresses = _check_public(url, hosts)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        opener = urllib.request.build_opener(
            _NoRedirect(),
            _PinnedHTTPSHandler(addresses, host),
        )
        try:
            with opener.open(request, timeout=timeout) as response:
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
