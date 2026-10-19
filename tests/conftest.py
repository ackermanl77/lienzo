"""Cada prueba usa su propia carpeta de datos (nunca la del usuario)."""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    folder = tmp_path / "datos"
    monkeypatch.setenv("LIENZO_DATA_DIR", str(folder))
    return folder


def png_bytes(size=(40, 30), color=(200, 30, 90, 255), fmt="PNG"):
    from PIL import Image

    out = io.BytesIO()
    image = Image.new("RGBA" if fmt == "PNG" else "RGB", size, color if fmt == "PNG" else color[:3])
    image.save(out, fmt)
    return out.getvalue()


def png_data_url(size=(40, 30), color=(200, 30, 90, 255)):
    import base64

    return "data:image/png;base64," + base64.b64encode(png_bytes(size, color)).decode()
