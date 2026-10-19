"""Punto de entrada: la ventana de escritorio, o solo el servidor en el navegador."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import webbrowser
from logging.handlers import RotatingFileHandler

from . import __version__, paths


def _configure_logging() -> None:
    folder = os.path.join(paths.data_dir(), "logs")
    os.makedirs(folder, exist_ok=True)
    handler = RotatingFileHandler(os.path.join(folder, "lienzo.log"), maxBytes=1_000_000, backupCount=2,
                                  encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def _parse_args(argv):
    parser = argparse.ArgumentParser(prog="Lienzo", description="Editor de diseños local.")
    parser.add_argument("--navegador", action="store_true",
                        help="Abre el editor en el navegador en lugar de la ventana (útil para probar).")
    parser.add_argument("--puerto", type=int, default=0, help="Puerto local (0 = uno libre).")
    parser.add_argument("--sin-abrir", action="store_true", help="Con --navegador: no abrir el navegador.")
    parser.add_argument("--depurar", action="store_true", help="Herramientas de desarrollo en la ventana.")
    parser.add_argument("--version", action="version", version=f"Lienzo {__version__}")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    _configure_logging()
    if args.navegador:
        from .server import LienzoServer

        server = LienzoServer(port=args.puerto)
        print(f"Lienzo en {server.url}", flush=True)
        if not args.sin_abrir:
            webbrowser.open(server.url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0
    from .desktop import run

    return run(port=args.puerto, debug=args.depurar)


if __name__ == "__main__":
    raise SystemExit(main())
