"""Punto de entrada: la ventana de escritorio, o solo el servidor en el navegador."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import webbrowser
from logging.handlers import RotatingFileHandler

from . import __version__, paths


def _log_folder() -> str:
    return os.path.join(paths.data_dir(), "logs")


def _configure_logging() -> None:
    folder = _log_folder()
    os.makedirs(folder, exist_ok=True)
    handler = RotatingFileHandler(os.path.join(folder, "lienzo.log"), maxBytes=1_000_000, backupCount=2,
                                  encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def _install_excepthooks() -> None:
    """El .exe no tiene consola: un error no capturado (al arrancar o en un hilo) queda en
    lienzo.log en vez de perderse."""
    log = logging.getLogger("lienzo")

    def hook(exc_type, exc, tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc, tb)
            return
        log.critical("Error no capturado", exc_info=(exc_type, exc, tb))

    sys.excepthook = hook
    threading.excepthook = lambda args: (
        None if args.exc_type is SystemExit else hook(args.exc_type, args.exc_value, args.exc_traceback))


def _show_error(message: str) -> None:
    """Un cuadro de mensaje nativo: sin consola, un fallo al arrancar no se vería."""
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, message, "Lienzo", 0x10)  # MB_ICONERROR
            return
        except (AttributeError, OSError):
            pass
    print(message, file=sys.stderr)


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
    _install_excepthooks()
    from .server import start_update_check

    start_update_check()  # no hace nada hasta que update_check.UPDATE_FEED_URL tenga un valor
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
    try:
        from .desktop import run

        return run(port=args.puerto, debug=args.depurar)
    except Exception as error:  # noqa: BLE001 - todo fallo al arrancar se muestra
        logging.getLogger("lienzo").exception("No se pudo abrir la ventana")
        _show_error(f"Lienzo no pudo abrirse: {error}\n\nLos detalles están en:\n{_log_folder()}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
