"""Las funciones nuevas: grupos/animación/tablas/gráficos/video en el modelo,
fuentes, fotos de Openverse, IA local, quitar fondo, videos y rangos HTTP."""
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import png_bytes
from PIL import Image, ImageDraw

from app import ai, fonts, imaging, model, net, stock, store, templates

TTF = b"\x00\x01\x00\x00" + b"\x00" * 200
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 100
WEBM = bytes.fromhex("1a45dfa3") + b"\x00" * 100


# ---------------------------------------------------------------- modelo
def page_of(*elements):
    return model.sanitize_design({"width": 1000, "height": 800, "pages": [{"elements": list(elements)}]})["pages"][0]


def test_groups_animations_and_page_duration_are_kept_and_cleaned():
    page = page_of(
        {"type": "rect", "group": "g1", "animation": {"type": "rise", "delay": 99, "duration": 0}},
        {"type": "rect", "group": "bad group!", "animation": {"type": "explode"}},
    )
    first, second = page["elements"]
    assert first["group"] == "g1" and first["animation"] == {"type": "rise", "delay": 60, "duration": 0.1}
    assert "group" not in second and "animation" not in second
    assert page["duration"] == model.PAGE_DURATION
    assert model.sanitize_page({"duration": 999}, 100, 100)["duration"] == 120


def test_tables_are_normalised():
    (table,) = page_of({"type": "table", "rows": 2, "cols": 3, "cells": [["a", "b"], "nope", ["x"] * 9],
                        "colWidths": [2, 1], "headerFill": "red", "header": False})["elements"]
    assert (table["rows"], table["cols"]) == (2, 3)
    assert table["cells"] == [["a", "b", ""], ["", "", ""]]
    assert sum(table["colWidths"]) == pytest.approx(1) and table["colWidths"][0] == pytest.approx(0.5)
    assert table["headerFill"] == "#6c3cf0" and table["header"] is False
    (big,) = page_of({"type": "table", "rows": 999, "cols": 999})["elements"]
    assert (big["rows"], big["cols"]) == (model.MAX_TABLE_ROWS, model.MAX_TABLE_COLS)


def test_graphics_video_fills_and_any_safe_font_name():
    graphic, video, text = page_of(
        {"type": "graphic", "name": "seal", "fill": {"color": "#112233", "image": "0123456789abcdef"}},
        {"type": "rect", "fill": {"video": "0123456789abcdef", "image": "fedcba9876543210"}},
        {"type": "text", "text": "x", "fontFamily": "Playfair Display"},
    )["elements"]
    assert graphic["name"] == "seal" and graphic["fill"] == {"color": "#112233"}
    assert video["fill"]["video"] == "0123456789abcdef" and "image" not in video["fill"]
    assert text["fontFamily"] == "Playfair Display"
    (bad,) = page_of({"type": "graphic", "name": "../x"})["elements"]
    assert bad["name"] == "star"


# ---------------------------------------------------------------- videos y rangos
def test_videos_are_checked_by_signature_and_range():
    v = store.add_video(MP4, "clip.mp4", 1920, 1080, 12.345)
    assert (v["kind"], v["width"], v["duration"]) == ("video", 1920, 12.35)
    assert store.asset_file(v["id"])[1] == "video/mp4"
    assert store.add_video(WEBM, "c.webm", 640, 360, 3)["url"].startswith("/assets/")
    for data, w, h, d in ((b"not a video at all", 10, 10, 1), (MP4, 0, 10, 1), (MP4, 10, 10, 0), (MP4, "x", 1, 1)):
        with pytest.raises(store.StoreError):
            store.add_video(data, "x", w, h, d)
    with pytest.raises(store.StoreError):
        store.asset_bytes(v["id"])  # un video no es una imagen


# ---------------------------------------------------------------- quitar fondo
def test_plain_backgrounds_are_removed():
    image = Image.new("RGB", (200, 160), "#ffffff")
    ImageDraw.Draw(image).ellipse((60, 40, 140, 120), fill="#d02040")
    out = io.BytesIO()
    image.save(out, "PNG")
    result = Image.open(io.BytesIO(imaging.remove_plain_background(out.getvalue(), 40)))
    assert result.mode == "RGBA"
    assert result.getpixel((5, 5))[3] == 0          # fondo transparente
    assert result.getpixel((100, 80))[3] == 255     # el objeto queda
    asset = store.add_asset(out.getvalue(), "pelota.png")
    copy = imaging.remove_background_asset(asset["id"])
    assert copy["name"] == "pelota (sin fondo).png" and copy["id"] != asset["id"]
    with pytest.raises(store.StoreError):
        imaging.remove_plain_background(png_bytes((50, 50)), 40)  # todo es "fondo": nada que separar


# ---------------------------------------------------------------- fuentes
def test_google_fonts_are_downloaded_and_listed(monkeypatch):
    css = ("@font-face {\n  font-family: 'Lobster';\n  font-style: normal;\n  font-weight: 400;\n"
           "  src: url(https://fonts.gstatic.com/s/lobster/v32/abc.ttf) format('truetype');\n}\n")
    calls = []

    def fake_fetch(url, limit, hosts=None, **kw):
        calls.append(url)
        assert hosts == fonts.GOOGLE_HOSTS
        if "googleapis" in url:
            if ":ital" in url or ":wght" in url:
                raise net.NetError("El servidor respondió con el error 400.")
            return css.encode()
        return TTF

    monkeypatch.setattr(net, "fetch", fake_fetch)
    font = fonts.install_google("  Lobster ")
    assert font["family"] == "Lobster"
    assert font["files"] == [{"url": "/fonts/lobster-normal-400.ttf", "style": "normal", "weight": 400}]
    assert len(calls) == 4  # dos intentos con variantes, el CSS simple y el archivo
    assert [f["family"] for f in fonts.installed()] == ["Lobster"]
    assert fonts.font_file("lobster-normal-400.ttf")[1] == "font/ttf"
    assert fonts.font_file("../secret.ttf") is None
    assert fonts.remove("Lobster") and not fonts.installed()


def test_font_files_names_and_bad_input(monkeypatch):
    font = fonts.install_file(TTF, "", "MiLetra-BoldItalic.ttf")
    assert font["family"] == "MiLetra" and font["files"][0]["style"] == "italic" and font["files"][0]["weight"] == 700
    for bad_family in ("Arial", "<script>", ""):
        with pytest.raises(store.StoreError):
            fonts.install_file(TTF, bad_family, "")
    with pytest.raises(store.StoreError):
        fonts.install_file(b"NOTAFONT" * 10, "Algo", "a.ttf")
    def missing(*args, **kwargs):
        raise net.NetError("El servidor respondió con el error 400.")

    monkeypatch.setattr(net, "fetch", missing)
    with pytest.raises(store.StoreError, match="no tiene una fuente"):
        fonts.install_google("No Existe")


# ---------------------------------------------------------------- red segura
@pytest.mark.parametrize("url", ["http://example.com/x", "https://127.0.0.1/x", "https://localhost/x", "ftp://a/b"])
def test_fetch_refuses_plain_http_and_private_addresses(url):
    with pytest.raises(net.NetError):
        net.fetch(url, 100)


def test_fetch_restricts_hosts():
    with pytest.raises(net.NetError, match="no permitido"):
        net.fetch("https://evil.example/x", 100, ("fonts.gstatic.com",))


# ---------------------------------------------------------------- Openverse
ITEM = {"id": "f561777d-24ea-483f-9cf8-f17aa1fd6aa3", "title": "Mountains", "creator": "Kamil", "license": "by-sa",
        "license_version": "2.0", "license_url": "https://creativecommons.org/licenses/by-sa/2.0/",
        "foreign_landing_url": "https://www.flickr.com/x", "url": "https://live.staticflickr.com/x.jpg",
        "attribution": '"Mountains" by Kamil is licensed under CC BY-SA 2.0.', "width": 1024, "height": 680}


def test_stock_search_and_import(monkeypatch):
    seen = []

    def fake_fetch(url, limit, hosts=None, **kw):
        seen.append(url)
        if "?q=" in url:
            return json.dumps({"results": [ITEM, {"id": "not-a-uuid"}], "page_count": 7}).encode()
        if url.endswith(ITEM["id"] + "/"):
            return json.dumps(ITEM).encode()
        assert url == ITEM["url"] and hosts is None
        return png_bytes((64, 40))

    monkeypatch.setattr(net, "fetch", fake_fetch)
    result = stock.search(" montañas  nevadas ", 2)
    assert "license_type=commercial%2Cmodification" in seen[0] and "q=monta%C3%B1as+nevadas" in seen[0]
    assert len(result["results"]) == 1 and result["pages"] == 7
    assert result["results"][0]["credit"]["license"] == "CC BY-SA 2.0"
    asset = stock.import_image(ITEM["id"])
    assert asset["credit"]["creator"] == "Kamil" and asset["width"] == 64
    assert store.list_assets()[0]["credit"]["title"] == "Mountains"
    with pytest.raises(store.StoreError):
        stock.import_image("../../etc/passwd")
    with pytest.raises(store.StoreError):
        stock.search("   ")


# ---------------------------------------------------------------- IA local (servidor falso compatible con OpenAI)
class FakeLLM(BaseHTTPRequestHandler):
    replies = []
    requests = []

    def log_message(self, *a):
        pass

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json({"data": [{"id": "llama3"}, {"id": "qwen"}]})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeLLM.requests.append(payload)
        self._json({"choices": [{"message": {"content": FakeLLM.replies.pop(0)}}]})


@pytest.fixture()
def llm():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    FakeLLM.replies, FakeLLM.requests = [], []
    ai.save_settings(f"http://127.0.0.1:{srv.server_address[1]}/v1", "")
    yield FakeLLM
    srv.shutdown()
    srv.server_close()


def test_ai_settings_only_accept_this_pc():
    for bad in ("http://example.com/v1", "http://192.168.1.10:11434/v1", "file:///etc", ""):
        with pytest.raises(ai.AIError):
            ai.save_settings(bad, "")
    assert ai.save_settings("http://localhost:1234/v1/", "m")["url"] == "http://localhost:1234/v1"


def test_ai_status_write_and_rewrite(llm):
    status = ai.status()
    assert status["ok"] and status["models"] == ["llama3", "qwen"]
    llm.replies = ['Here is your slogan: "Café que despierta ideas"', "<think>hmm</think>Más corto."]
    assert ai.write("eslogan para cafetería") == "Café que despierta ideas"
    assert llm.requests[0]["model"] == "llama3"  # sin modelo elegido, el primero
    assert ai.rewrite("Un texto largo", "shorter") == "Más corto."
    assert "shorter" in llm.requests[1]["messages"][1]["content"]
    with pytest.raises(ai.AIError):
        ai.rewrite("x", "nope")
    with pytest.raises(ai.AIError):
        ai.write("   ")


def test_magic_design_builds_a_readable_page(llm):
    llm.replies = ['Sure! {"title": "Verano 2x1", "subtitle": "Todos los viernes", "body": "", "cta": "Ven hoy", '
                   '"style": "divertido", "background": "#ffffff", "accent": "#ff6b35", "text": "#fafafa"}']
    page = ai.magic_design("promoción de heladería", 1080, 1350, style="audaz")
    texts = [el for el in page["elements"] if el["type"] == "text"]
    assert texts[0]["text"] == "VERANO 2X1" and texts[0]["fontFamily"] == "Impact"  # el estilo pedido manda
    assert all(templates.contrast(t["color"], "#ffffff") >= 4.5 for t in texts[:2])  # el texto claro se corrige
    llm.replies = ["no json here"]
    with pytest.raises(ai.AIError):
        ai.magic_design("x", 1080, 1080)


def test_ai_without_a_server_says_so():
    ai.save_settings("http://127.0.0.1:9/v1", "")
    assert ai.status()["ok"] is False
    with pytest.raises(ai.AIError, match="Ollama"):
        ai.write("hola")
