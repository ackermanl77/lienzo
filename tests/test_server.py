"""La API local sobre un servidor real en un puerto libre."""
import http.client
import json
import threading

import pytest
from conftest import png_bytes, png_data_url

from app import main as app_main
from app.server import LienzoServer

TOKEN = "k" * 32


@pytest.fixture()
def server():
    srv = LienzoServer(port=0, token=TOKEN)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()
    srv.server_close()


def call(srv, method, path, body=None, token=TOKEN, raw=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
    h = dict(headers or {})
    if token:
        h["X-Lienzo-Token"] = token
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=h)
    response = conn.getresponse()
    payload = response.read()
    conn.close()
    kind = response.getheader("Content-Type", "")
    return response.status, (json.loads(payload) if kind.startswith("application/json") else payload), response


def test_the_api_needs_the_key_and_a_local_host(server):
    assert call(server, "GET", "/api/disenos", token="")[0] == 401
    assert call(server, "GET", "/api/disenos", token="wrong")[0] == 401
    assert call(server, "GET", "/api/disenos", headers={"Host": "evil.example:80"})[0] == 403
    assert call(server, "GET", "/api/disenos")[0] == 200
    assert server.url.endswith(f"/?t={TOKEN}")


def test_pages_and_static_files(server):
    for path in ("/", "/editor", "/js/editor.js", "/js/model.js", "/css/app.css", "/img/icon.svg"):
        status, _, response = call(server, "GET", path, token="")
        assert status == 200, path
    assert call(server, "GET", "/js/editor.js", token="")[2].getheader("Content-Type").startswith("text/javascript")
    assert call(server, "GET", "/../app/server.py", token="")[0] == 404
    assert call(server, "GET", "/%2e%2e/app/server.py", token="")[0] == 404


def test_designs_are_created_from_formats_templates_and_custom_sizes(server):
    status, d, _ = call(server, "POST", "/api/disenos", {"formato": "instagram_story"})
    assert status == 200 and (d["width"], d["height"], d["title"]) == (1080, 1920, "Historia de Instagram")
    status, t, _ = call(server, "POST", "/api/disenos", {"formato": "instagram_post", "plantilla": "sale"})
    assert status == 200 and len(t["pages"][0]["elements"]) > 3
    status, c, _ = call(server, "POST", "/api/disenos", {"ancho": 800, "alto": 600, "titulo": "Mío"})
    assert (c["format"], c["title"]) == ("custom", "Mío")
    status, err, _ = call(server, "POST", "/api/disenos", {"ancho": 10, "alto": 600})
    assert status == 400 and "entre 40 y 8000" in err["error"]
    for width in (800.5, float("inf")):
        assert call(server, "POST", "/api/disenos", {"ancho": width, "alto": 600})[0] == 400
    assert call(server, "POST", "/api/disenos", {"formato": "instagram_post", "plantilla": "zzz"})[0] == 400
    assert len(call(server, "GET", "/api/disenos")[1]) == 3
    assert len(call(server, "GET", "/api/plantillas?ancho=1920&alto=1080")[1]) == 8
    assert len(call(server, "GET", "/api/formatos")[1]) == 12


def test_saving_duplicating_and_deleting_a_design(server):
    d = call(server, "POST", "/api/disenos", {"formato": "logo"})[1]
    d["title"] = "Logo nuevo"
    d["pages"][0]["elements"].append({"type": "text", "text": "Hola", "left": 10, "top": 10, "width": 200})
    status, saved, _ = call(server, "PUT", f"/api/disenos/{d['id']}", {"diseno": d, "miniatura": png_data_url()})
    assert status == 200 and saved["title"] == "Logo nuevo"
    loaded = call(server, "GET", f"/api/disenos/{d['id']}")[1]
    assert loaded["pages"][0]["elements"][0]["text"] == "Hola"
    assert call(server, "GET", f"/thumbs/{d['id']}.png", token="")[0] == 200
    other = dict(d, id="0" * 12)
    assert call(server, "PUT", f"/api/disenos/{d['id']}", {"diseno": other})[0] == 400
    copy = call(server, "POST", f"/api/disenos/{d['id']}/duplicar")[1]
    assert copy["title"] == "Logo nuevo (copia)"
    d["title"] = "Cambio desde pagehide"
    status, saved, _ = call(server, "PUT", f"/api/disenos/{d['id']}", {"diseno": d})
    assert status == 200 and saved["title"] == "Cambio desde pagehide"
    assert call(server, "GET", f"/thumbs/{d['id']}.png", token="")[0] == 200
    assert call(server, "DELETE", f"/api/disenos/{d['id']}")[0] == 200
    assert call(server, "GET", f"/api/disenos/{d['id']}")[0] == 404
    assert call(server, "DELETE", f"/api/disenos/{d['id']}")[0] == 404


def test_rejected_design_update_does_not_change_saved_design(server):
    d = call(server, "POST", "/api/disenos", {"formato": "logo"})[1]
    original_title = d["title"]
    d["title"] = "No guardar"
    status, error, _ = call(server, "PUT", f"/api/disenos/{d['id']}",
                            {"diseno": d, "miniatura": "data:image/png;base64,***"})
    assert status == 400 and "error" in error
    assert call(server, "GET", f"/api/disenos/{d['id']}")[1]["title"] == original_title


def test_uploading_and_serving_images(server):
    status, asset, _ = call(server, "POST", "/api/imagenes", raw=png_bytes((50, 40)),
                            headers={"X-Filename": "mi%20foto.png", "Content-Type": "application/octet-stream"})
    assert status == 200 and (asset["name"], asset["width"]) == ("mi foto.png", 50)
    status, data, response = call(server, "GET", asset["url"], token="")
    assert status == 200 and response.getheader("Content-Type") == "image/png" and data.startswith(b"\x89PNG")
    assert call(server, "POST", "/api/imagenes", raw=b"hello")[0] == 400
    assert [a["id"] for a in call(server, "GET", "/api/imagenes")[1]] == [asset["id"]]
    assert call(server, "DELETE", f"/api/imagenes/{asset['id']}")[0] == 200
    assert call(server, "GET", "/api/imagenes")[1] == []


def test_exporting_downloads_or_writes_the_file(server, tmp_path):
    d = call(server, "POST", "/api/disenos", {"formato": "a4_document"})[1]
    body = {"formato": "pdf", "paginas": [png_data_url((248, 351))], "titulo": "Informe", "diseno": d["id"],
            "escala": 1}
    status, data, response = call(server, "POST", "/api/exportar", body)
    assert status == 200 and data.startswith(b"%PDF")
    assert "Informe.pdf" in response.getheader("Content-Disposition")
    target = tmp_path / "salida" / "copia"
    target.parent.mkdir()
    status, result, _ = call(server, "POST", "/api/exportar", dict(body, ruta=str(target)))
    assert status == 200 and result["nombre"] == "copia.pdf"
    assert (tmp_path / "salida" / "copia.pdf").read_bytes().startswith(b"%PDF")
    assert call(server, "POST", "/api/exportar", dict(body, ruta="relativa.pdf"))[0] == 400
    assert call(server, "POST", "/api/exportar", dict(body, paginas="x"))[0] == 400


def test_bad_json_and_unknown_routes(server):
    assert call(server, "POST", "/api/disenos", raw=b"{nope", headers={"Content-Type": "application/json"})[0] == 400
    assert call(server, "GET", "/api/nada")[0] == 404
    assert call(server, "POST", "/editor", raw=b"x", token="")[0] == 405


def test_command_line_options():
    args = app_main._parse_args(["--navegador", "--puerto", "9000", "--sin-abrir"])
    assert (args.navegador, args.puerto, args.sin_abrir) == (True, 9000, True)


def test_video_upload_and_byte_ranges(server):
    mp4 = b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 4
    headers = {"X-Filename": "clip.mp4", "X-Width": "640", "X-Height": "360", "X-Duration": "2.5"}
    status, video, _ = call(server, "POST", "/api/videos", raw=mp4, headers=headers)
    assert status == 200 and video["kind"] == "video"
    status, data, response = call(server, "GET", video["url"], token="", headers={"Range": "bytes=16-31"})
    assert status == 206 and data == mp4[16:32]
    assert response.getheader("Content-Range") == f"bytes 16-31/{len(mp4)}"
    status, data, _ = call(server, "GET", video["url"], token="", headers={"Range": "bytes=-10"})
    assert status == 206 and data == mp4[-10:]
    assert call(server, "GET", video["url"], token="", headers={"Range": "bytes=99999-"})[0] == 416
    status, data, response = call(server, "GET", video["url"], token="")
    assert status == 200 and data == mp4 and response.getheader("Accept-Ranges") == "bytes"
    assert call(server, "POST", "/api/videos", raw=b"nope", headers=headers)[0] == 400


def test_saving_a_recorded_file_needs_a_real_folder_and_extension(server, tmp_path):
    target = tmp_path / "video.webm"
    status, result, _ = call(server, "POST", "/api/guardar-archivo", raw=b"webm-bytes",
                             headers={"X-Ruta": str(target).replace("\\", "%5C").replace(":", "%3A")})
    assert status == 200 and target.read_bytes() == b"webm-bytes" and result["nombre"] == "video.webm"
    assert call(server, "POST", "/api/guardar-archivo", raw=b"x", headers={"X-Ruta": str(tmp_path / "a.exe")})[0] == 400
    assert call(server, "POST", "/api/guardar-archivo", raw=b"x", headers={"X-Ruta": "relativo.webm"})[0] == 400


def test_fonts_routes_and_files(server):
    ttf = b"\x00\x01\x00\x00" + b"\x00" * 64
    status, font, _ = call(server, "POST", "/api/fuentes/subir", raw=ttf,
                           headers={"X-Filename": "Mia-Bold.ttf", "X-Family": "Mi%20Letra"})
    assert status == 200 and font["family"] == "Mi Letra"
    listing = call(server, "GET", "/api/fuentes")[1]
    assert [f["family"] for f in listing["instaladas"]] == ["Mi Letra"] and "Roboto" in listing["catalogo"]
    status, data, response = call(server, "GET", font["files"][0]["url"], token="")
    assert status == 200 and data == ttf and response.getheader("Content-Type") == "font/ttf"
    assert call(server, "DELETE", "/api/fuentes?familia=Mi%20Letra")[0] == 200
    assert call(server, "DELETE", "/api/fuentes?familia=Mi%20Letra")[0] == 404


def test_ai_routes_report_a_missing_server(server):
    assert call(server, "PUT", "/api/ia/ajustes", {"url": "http://example.com/v1"})[0] == 400
    assert call(server, "PUT", "/api/ia/ajustes", {"url": "http://127.0.0.1:9/v1", "modelo": ""})[0] == 200
    status, st, _ = call(server, "GET", "/api/ia/estado")
    assert status == 200 and st["ok"] is False
    status, err, _ = call(server, "POST", "/api/ia/escribir", {"instruccion": "hola"})
    assert status == 400 and "Ollama" in err["error"]
    assert call(server, "POST", "/api/ia/diseno", {"descripcion": "x", "ancho": 10, "alto": 10})[0] == 400


def test_the_brand_kit_is_cleaned_and_kept(server):
    """UI4: GET/PUT /api/marca keep valid, unique colours and fonts and an uploaded-image logo."""
    status, empty, _ = call(server, "GET", "/api/marca")
    assert status == 200 and empty == {"colores": [], "fuentes": [], "logo": None}
    body = {"colores": ["#FF0000", "#ff0000", "red", "#00ff00"], "fuentes": ["Arial", "Arial", "../x", "Mi Fuente 2"],
            "logo": "../../secret"}
    status, saved, _ = call(server, "PUT", "/api/marca", body)
    assert status == 200 and saved == {"colores": ["#ff0000", "#00ff00"], "fuentes": ["Arial", "Mi Fuente 2"], "logo": None}
    assert call(server, "GET", "/api/marca")[1] == saved
    status, saved, _ = call(server, "PUT", "/api/marca", {**saved, "logo": "0123456789abcdef", "colores": ["#123456"] * 1})
    assert saved["logo"] == "0123456789abcdef" and saved["colores"] == ["#123456"]
    many = call(server, "PUT", "/api/marca", {"colores": [f"#{i:06x}" for i in range(40)]})[1]
    assert len(many["colores"]) == 24


def test_update_route_reports_a_found_update_only(server, monkeypatch):
    from app import server as server_module
    from app import update_check

    assert call(server, "GET", "/api/actualizacion")[:2] == (200, {})
    monkeypatch.setattr(server_module, "_found_update",
                        update_check.UpdateInfo("9.0.0", "https://example.com/get", "Más rápido"))
    status, info, _ = call(server, "GET", "/api/actualizacion")
    assert status == 200
    assert info == {"version": "9.0.0", "url": "https://example.com/get", "notas": "Más rápido"}


def test_uncaught_errors_go_to_the_log(monkeypatch):
    import logging
    import sys

    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger("lienzo").addHandler(handler)
    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    monkeypatch.setattr(threading, "excepthook", threading.excepthook)
    try:
        app_main._install_excepthooks()
        worker = threading.Thread(target=lambda: 1 / 0)
        worker.start()
        worker.join()
    finally:
        logging.getLogger("lienzo").removeHandler(handler)
    assert records and records[0].exc_info[0] is ZeroDivisionError


def test_a_window_that_cannot_open_shows_a_message(monkeypatch):
    shown = []
    monkeypatch.setattr(app_main, "_show_error", shown.append)
    monkeypatch.setattr(app_main, "_configure_logging", lambda: None)
    monkeypatch.setattr(app_main, "_install_excepthooks", lambda: None)

    def broken_run(**kwargs):
        raise RuntimeError("sin WebView2")

    import app.desktop
    monkeypatch.setattr(app.desktop, "run", broken_run)
    assert app_main.main([]) == 1
    assert "sin WebView2" in shown[0]
