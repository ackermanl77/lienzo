"""Guardado en disco e imágenes subidas; exportación PNG/JPG/ZIP/PDF."""
import io
import zipfile

import pytest
from conftest import png_bytes, png_data_url
from PIL import Image

from app import exporter, model, store


def test_designs_are_saved_listed_duplicated_and_deleted():
    d = model.new_design(1080, 1080, "Uno", "instagram_post")
    saved = store.save_design(d, png_data_url())
    assert store.load_design(saved["id"])["title"] == "Uno"
    items = store.list_designs()
    assert [i["id"] for i in items] == [saved["id"]]
    assert items[0]["thumb"].startswith(f"/thumbs/{saved['id']}.png")
    copy = store.duplicate_design(saved["id"])
    assert copy["title"] == "Uno (copia)" and copy["id"] != saved["id"]
    assert len(store.list_designs()) == 2
    assert store.delete_design(saved["id"]) is True
    assert store.delete_design(saved["id"]) is False
    with pytest.raises(store.StoreError):
        store.duplicate_design("0" * 12)


def test_saving_keeps_the_creation_date():
    d = store.save_design(model.new_design(500, 500))
    created = d["created"]
    again = store.save_design(dict(d, created=1.0, title="Otro"))
    assert again["created"] == created and again["title"] == "Otro"


@pytest.mark.parametrize("bad", ["", "data:image/png;base64,***", "data:image/jpeg;base64,AAAA",
                                 "data:image/png;base64,aGVsbG8="])
def test_thumbnails_must_be_real_pngs(bad):
    design = model.new_design(500, 500)
    saved = store.save_design(design)
    with pytest.raises(store.StoreError):
        store.save_design(dict(saved, title="No guardar"), bad or "x")
    assert store.load_design(saved["id"])["title"] == saved["title"]
    assert store.list_designs()[0]["id"] == saved["id"]


def test_invalid_thumbnail_does_not_create_design():
    design = model.new_design(500, 500)
    with pytest.raises(store.StoreError):
        store.save_design(design, "data:image/png;base64,***")
    assert store.load_design(design["id"]) is None
    assert store.list_designs() == []


@pytest.mark.parametrize("existing", [True, False])
def test_failed_thumbnail_write_does_not_persist_design(existing, monkeypatch):
    design = model.new_design(500, 500)
    saved = store.save_design(design) if existing else design
    original_atomic_write = store.atomic_write

    def fail_thumbnail_write(path, data):
        if path == store.thumb_path(saved["id"]):
            raise OSError("thumbnail write failed")
        original_atomic_write(path, data)

    monkeypatch.setattr(store, "atomic_write", fail_thumbnail_write)
    with pytest.raises(OSError, match="thumbnail write failed"):
        store.save_design(dict(saved, title="No guardar"), png_data_url())
    persisted = store.load_design(saved["id"])
    if existing:
        assert persisted["title"] == saved["title"]
    else:
        assert persisted is None


def test_uploads_are_validated_listed_served_and_hidden():
    asset = store.add_asset(png_bytes((64, 48)), "C:\\fotos\\gato.png")
    assert (asset["name"], asset["width"], asset["height"]) == ("gato.png", 64, 48)
    assert asset["url"] == f"/assets/{asset['id']}"
    jpg = store.add_asset(png_bytes(fmt="JPEG"), "foto.jpg")
    assert store.asset_file(jpg["id"])[1] == "image/jpeg"
    assert [a["id"] for a in store.list_assets()] == [jpg["id"], asset["id"]]
    assert store.delete_asset(asset["id"]) is True
    assert [a["id"] for a in store.list_assets()] == [jpg["id"]]
    # Los diseños que ya la usan la siguen viendo.
    assert store.asset_file(asset["id"]) is not None
    assert store.delete_asset(asset["id"]) is False
    for bad in (b"", b"not an image", png_bytes(fmt="BMP")):
        with pytest.raises(store.StoreError):
            store.add_asset(bad, "x")
    assert store.asset_file("../../secret") is None


def test_png_and_jpg_exports_of_one_page():
    data, name, mime = exporter.build("png", [png_data_url((30, 20))], "Mi: diseño?", 300)
    assert (name, mime) == ("Mi diseño.png", "image/png")
    image = Image.open(io.BytesIO(data))
    assert image.size == (30, 20) and round(image.info["dpi"][0]) == 300
    data, name, mime = exporter.build("jpg", [png_data_url((30, 20), (0, 0, 0, 0))], "", 96)
    assert name == "diseño.jpg"
    assert Image.open(io.BytesIO(data)).getpixel((5, 5)) == (255, 255, 255)  # lo transparente queda blanco


def test_several_pages_as_images_come_in_a_zip():
    data, name, mime = exporter.build("png", [png_data_url(), png_data_url()], "Libro", 96)
    assert (name, mime) == ("Libro.zip", "application/zip")
    assert zipfile.ZipFile(io.BytesIO(data)).namelist() == ["Libro - página 1.png", "Libro - página 2.png"]


def test_pdf_has_one_page_per_image_with_the_physical_size():
    data, name, mime = exporter.build("pdf", [png_data_url((300, 600)), png_data_url((300, 600))], "Cartel", 300)
    assert (name, mime) == ("Cartel.pdf", "application/pdf")
    assert data.startswith(b"%PDF")
    assert data.count(b"/Type /Page\n") + data.count(b"/Type /Page\r") + data.count(b"/Type /Page ") >= 2
    assert b"/MediaBox [ 0 0 72.0 144.0 ]" in data  # 300 x 600 px a 300 ppp = 1 x 2 pulgadas


def test_bad_exports_are_refused():
    with pytest.raises(store.StoreError):
        exporter.build("gif", [png_data_url()], "x")
    with pytest.raises(store.StoreError):
        exporter.build("png", [], "x")
