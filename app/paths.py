"""Dónde viven los datos del usuario y los archivos de la página."""

from __future__ import annotations

import os
import sys


def data_dir() -> str:
    """Carpeta de datos (diseños, miniaturas, imágenes subidas).

    LIENZO_DATA_DIR la cambia (las pruebas la usan); por defecto es
    %LOCALAPPDATA%\\Lienzo en Windows, fuera de OneDrive.
    """
    base = os.environ.get("LIENZO_DATA_DIR", "").strip()
    if not base:
        if os.name == "nt":
            base = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Lienzo")
        else:
            base = os.path.join(os.path.expanduser("~"), ".local", "share", "lienzo")
    os.makedirs(base, exist_ok=True)
    return base


def web_dir() -> str:
    """La carpeta web/ (junto al código, o dentro del ejecutable de PyInstaller)."""
    root = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "web")
