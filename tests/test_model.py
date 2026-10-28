"""El modelo del diseño: validación, límites y plantillas."""
import pytest

from app import model, templates


def design(**extra):
    return {"width": 1080, "height": 1080, "pages": [{"elements": []}], **extra}


def test_sizes_follow_the_documented_limits():
    assert model.check_size(40, 8000) == (40, 8000)
    for bad in ((39, 100), (100, 8001), ("x", 100), (None, 100)):
        with pytest.raises(model.DesignError):
            model.check_size(*bad)
    assert model.check_size(40.0, "8000") == (40, 8000)
    for bad in ((40.5, 100), (100, 50.25), (float("inf"), 100), (100, float("-inf")),
                (float("nan"), 100), (True, 100)):
        with pytest.raises(model.DesignError):
            model.check_size(*bad)
    with pytest.raises(model.DesignError):
        model.check_size(6000, 6000)  # 36 MP > 25 MP


def test_a_design_needs_pages_and_a_bounded_page_count():
    with pytest.raises(model.DesignError):
        model.sanitize_design(design(pages=[]))
    with pytest.raises(model.DesignError):
        model.sanitize_design(design(pages=[{}] * (model.MAX_PAGES + 1)))
    with pytest.raises(model.DesignError):
        model.sanitize_design("nope")


def test_elements_are_cleaned_clamped_and_unknown_ones_dropped():
    raw = design(pages=[{"background": {"color": "red", "image": "../x"}, "elements": [
        {"type": "text", "id": "a", "text": "Hola", "fontSize": 99999, "fontFamily": "<b>x</b>",
         "transparency": 7, "align": "justify", "color": "#ABCDEF"},
        {"type": "rect", "id": "a", "width": -5, "fill": {"image": "0123456789abcdef"}, "radius": "big"},
        {"type": "shape", "kind": "blob", "rotation": 9999, "locked": "yes"},
        {"type": "video"},
        "garbage",
    ]}])
    clean = model.sanitize_design(raw)
    page = clean["pages"][0]
    assert page["background"] == {"color": "#ffffff"}
    text, rect, shape = page["elements"]
    assert (text["fontSize"], text["fontFamily"], text["transparency"], text["align"], text["color"]) == \
        (1000, "Arial", 1, "left", "#abcdef")
    assert rect["id"] != "a"  # ids repetidos en la página se renuevan
    assert rect["width"] == 1 and rect["radius"] == 0 and rect["fill"]["image"] == "0123456789abcdef"
    assert (shape["kind"], shape["rotation"], shape["locked"]) == ("ellipse", 360, False)


def test_new_designs_take_the_format_name_and_custom_sizes():
    d = model.new_design(1080, 1920, fmt="instagram_story")
    assert d["title"] == "Historia de Instagram" and model.is_design_id(d["id"])
    assert model.dpi_for(d) == 96
    assert model.dpi_for(model.new_design(2480, 3508, fmt="a4_document")) == 300
    custom = model.sanitize_design(design(format="whatever", title="  Mi   cartel  "))
    assert (custom["format"], custom["title"]) == ("custom", "Mi cartel")


def test_formats_are_valid_sizes():
    for item in model.formats():
        model.check_size(item["ancho"], item["alto"])


@pytest.mark.parametrize("size", [(1080, 1080), (1080, 1920), (1920, 1080), (500, 500), (3508, 4961)])
def test_every_template_builds_a_valid_page_inside_the_page(size):
    width, height = size
    for item in templates.templates_for(width, height):
        page = item["pagina"]
        assert page["elements"], item["id"]
        for el in page["elements"]:
            if el["type"] == "text":
                assert 0 <= el["left"] and el["left"] + el["width"] <= width + 1, (item["id"], el["text"])
                assert 0 <= el["top"] < height, (item["id"], el["text"])
        assert model.sanitize_page(page, width, height) == page


def test_unknown_templates_are_refused():
    with pytest.raises(model.DesignError):
        templates.template_page("nope", 100, 100)
