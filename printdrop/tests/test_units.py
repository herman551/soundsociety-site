"""Fast checks that don't need CUPS running."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from printdrop.config import load_config  # noqa: E402
from printdrop.convert import match_page_size  # noqa: E402
from printdrop.ppd import parse_ppd  # noqa: E402
from printdrop import settings as S  # noqa: E402

PPD = ROOT / "ppd" / "Ricoh-IM_C3510_PS.ppd"


@pytest.fixture(scope="module")
def cfg(tmp_path_factory):
    os.environ["PRINTDROP_DATA"] = str(tmp_path_factory.mktemp("data"))
    os.environ["PRINTDROP_CONFIG"] = str(ROOT / "config" / "printdrop.yml")
    return load_config()


@pytest.fixture(scope="module")
def ppd():
    return parse_ppd(PPD)


def test_ppd_has_the_trays_and_sizes_we_use(ppd):
    assert ppd.model == "Ricoh IM C3510"
    assert set(ppd.choices("InputSlot")) >= {"Auto", "1Tray", "2Tray", "3Tray", "4Tray", "MultiTray"}
    assert ppd.paper["Tabloid"] == (792.0, 1224.0)
    assert ppd.custom_limits["Width"] == (255.0, 908.0)


def test_every_config_choice_exists_in_the_driver(cfg, ppd):
    table = S.paper_table(cfg, ppd)
    for tray in cfg.trays:
        assert ppd.has_choice("InputSlot", tray["id"]), tray
        if tray.get("paper"):
            assert tray["paper"] in table
    for size in cfg.page_sizes:
        assert size["id"] in table, size
    for media in cfg.media_types:
        assert ppd.has_choice("MediaType", media["id"]), media
    for option, value in cfg.installed.items():
        assert ppd.has_choice(option, value), (option, value)
    for preset in cfg.presets:
        S.resolve(cfg, ppd, preset["settings"])  # raises if anything is off


def test_13x10_is_a_custom_size_fed_10_inch_edge_first(cfg, ppd):
    paper = S.paper_table(cfg, ppd)["10x13"]
    assert (paper.width, paper.height) == (720, 936)
    assert paper.cups_value == "Custom.720x936"


def test_custom_size_wider_than_bypass_is_rejected(cfg, ppd):
    cfg.raw["page_sizes"] = [*cfg.page_sizes, {"id": "wide", "width_in": 13, "height_in": 10}]
    try:
        with pytest.raises(S.SettingsError, match="wide"):
            S.paper_table(cfg, ppd)
    finally:
        cfg.raw["page_sizes"] = cfg.page_sizes[:-1]


def test_match_page_size_either_orientation():
    menu = {"Letter": (612, 792), "10x13": (720, 936), "Tabloid": (792, 1224)}
    assert match_page_size((936, 720), menu) == "10x13"
    assert match_page_size((792, 612), menu) == "Letter"
    assert match_page_size((1224, 792), menu) == "Tabloid"
    assert match_page_size((595, 842), menu) is None  # A4 isn't in this menu
    assert match_page_size(None, menu) is None


@pytest.mark.parametrize("bad, message", [
    ({"InputSlot": "9Tray"}, "Tray"),
    ({"PageSize": "Postcard"}, "paper size"),
    ({"copies": 0}, "Copies"),
    ({"page_ranges": "3-1"}, "page range"),
    ({"page_ranges": "abc"}, "Pages"),
    ({"pin": "12"}, "PIN"),
    ({"scaling": "huge"}, "Scaling"),
])
def test_bad_settings_get_a_readable_error(cfg, ppd, bad, message):
    with pytest.raises(S.SettingsError, match=message):
        S.resolve(cfg, ppd, bad)


def test_layers_override_in_order(cfg, ppd):
    s = S.resolve(cfg, ppd, {"PageSize": "Letter", "ColorModel": "Gray"}, {"ColorModel": "CMYK", "copies": "3"})
    assert (s.PageSize, s.ColorModel, s.copies) == ("Letter", "CMYK", 3)


def test_cups_options(cfg, ppd):
    s = S.resolve(cfg, ppd, {"PageSize": "10x13", "InputSlot": "MultiTray", "copies": 2, "pin": "4321",
                             "page_ranges": "1-2, 4"})
    opts = S.cups_options(s, S.paper_table(cfg, ppd)["10x13"], cfg, "Jamie Rivera")
    assert opts["PageSize"] == "Custom.720x936"
    assert opts["InputSlot"] == "MultiTray"
    assert opts["Collate"] == "True"
    assert opts["page-ranges"] == "1-2,4"
    assert opts["JobType"] == "LockedPrint" and opts["LockedPrintPassword"] == "4321"
    assert opts["UserId"] == "JamieRiv"  # Ricoh shows at most 8 characters
    assert "UserCode" not in opts


def test_ricoh_user_id():
    assert S.ricoh_user_id("Ana María") == "AnaMara"
    assert S.ricoh_user_id("   ") is None
    assert S.ricoh_user_id(None) is None
