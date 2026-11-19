"""End to end: web API -> conversion -> routing -> CUPS + the real Ricoh
driver -> a fake printer, then check the PostScript the Ricoh would get.

Needs a running CUPS (cupsd) and permission to add queues (root), plus
ghostscript. Run:  sudo python3 -m pytest tests/test_e2e.py
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

cups = pytest.importorskip("cups")
fastapi_testclient = pytest.importorskip("fastapi.testclient")

import fake_printer  # noqa: E402
from psfeatures import features  # noqa: E402

QUEUE = "printdrop-test"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _cups_ok() -> bool:
    try:
        cups.Connection().getPrinters()
        return os.geteuid() == 0 and shutil.which("gs") is not None
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _cups_ok(), reason="needs cupsd, root and ghostscript")


def wait_for(predicate, timeout=40.0, interval=0.3):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(interval)
    raise AssertionError("timed out waiting")


def make_pdf(path: Path, width: float, height: float, pages: int = 1) -> Path:
    ps = path.with_suffix(".ps")
    ps.write_text("%!PS\n/Helvetica findfont 40 scalefont setfont\n"
                  + "".join(f"72 200 moveto (Page {i + 1}) show showpage\n" for i in range(pages)))
    subprocess.run(["gs", "-q", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", f"-dDEVICEWIDTHPOINTS={width}",
                    f"-dDEVICEHEIGHTPOINTS={height}", "-dFIXEDMEDIA", f"-sOutputFile={path}", str(ps)], check=True)
    return path


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("e2e")
    out = tmp / "printed"
    fake_printer.OUT = out
    raw_port, lpd_port = _free_port(), _free_port()
    servers = [fake_printer.Server(("127.0.0.1", raw_port), fake_printer.RawHandler),
               fake_printer.Server(("127.0.0.1", lpd_port), fake_printer.LPDHandler)]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()

    os.environ.update({
        "PRINTDROP_DATA": str(tmp / "data"),
        "PRINTDROP_CONFIG": str(ROOT / "config" / "printdrop.yml"),
        "PRINTER_QUEUE": QUEUE,
        # First entry is dead on purpose: PrintDrop should skip to the next.
        "PRINTER": f"socket://127.0.0.1:{_free_port()} socket://127.0.0.1:{raw_port}",
        "SMB_ENABLED": "1",
    })
    from printdrop.config import load_config
    from printdrop.printer import resolve_uri, setup_queue

    cfg = load_config()
    uri = resolve_uri(cfg)
    assert uri == f"socket://127.0.0.1:{raw_port}"
    setup_queue(cfg, uri)

    from printdrop.app import create_app

    app = create_app(cfg)
    with fastapi_testclient.TestClient(app) as client:
        files = tmp / "files"
        files.mkdir()
        yield {
            "client": client, "app": app, "cfg": cfg, "out": out, "files": files,
            "lpd_port": lpd_port, "raw_port": raw_port,
            "pdf_13x10": make_pdf(files / "poster 13x10.pdf", 936, 720),
            "pdf_tabloid": make_pdf(files / "tabloid.pdf", 792, 1224, pages=2),
            "pdf_letter2": make_pdf(files / "two pages.pdf", 612, 792, pages=2),
        }
    cups.Connection().deletePrinter(QUEUE)
    for s in servers:
        s.shutdown()


def submit(env, path: Path, settings: dict | None = None, preset: str = "", user: str = "Tester") -> dict:
    import json

    with open(path, "rb") as fh:
        r = env["client"].post("/api/jobs", files={"files": (path.name, fh)},
                               data={"settings": json.dumps(settings or {}), "preset": preset, "user": user})
    assert r.status_code == 200, r.text
    return r.json()["jobs"][0]


def job(env, job_id: str) -> dict:
    jobs = env["client"].get("/api/jobs?limit=200").json()["jobs"]
    return next(j for j in jobs if j["id"] == job_id)


def wait_state(env, job_id: str, *states: str, timeout=60.0) -> dict:
    return wait_for(lambda: (j := job(env, job_id))["state"] in states and j, timeout=timeout)


def printed(env, title: str) -> dict:
    def find():
        for f in sorted(env["out"].glob("*.prn")):
            feats = features(f)
            if feats.get("Title") == title:
                return feats
        return None
    return wait_for(find)


# ---------------------------------------------------------------------------


def test_13x10_file_goes_to_bypass_and_waits_for_paper(env):
    j = submit(env, env["pdf_13x10"], {"PageSize": "auto", "InputSlot": "Auto"}, user="Jamie Rivera")
    held = wait_state(env, j["id"], "held")
    assert held["bypass"] is True
    assert held["page_size"] == "10x13"
    assert held["load"] == {"size": "13 × 10", "media": "Plain paper", "feed_edge_in": 10.0}
    assert "10-inch edge" in held["message"]
    assert held["can_release"] is True
    assert not list(env["out"].glob("*.prn")) or all(
        features(f).get("Title") != "poster 13x10.pdf" for f in env["out"].glob("*.prn")), "held job printed early"

    env["client"].post(f"/api/jobs/{j['id']}/release")
    wait_state(env, j["id"], "sent")
    ps = printed(env, "poster 13x10.pdf")
    assert ps["InputSlot"] == "MultiTray"
    assert ps["CustomSize"] == "720x936"
    assert ps["usrid"] == "JamieRiv"


def test_tabloid_file_goes_to_the_drawers(env):
    j = submit(env, env["pdf_tabloid"])
    done = wait_state(env, j["id"], "sent")
    assert done["page_size"] == "Tabloid" and done["bypass"] is False and done["pages"] == 2
    ps = printed(env, "tabloid.pdf")
    assert ps["PageSize"] == "Tabloid" and ps["InputSlot"] == "Auto"


def test_cardstock_preset_can_skip_the_hold(env):
    path = env["files"] / "card.pdf"
    shutil.copy(env["pdf_letter2"], path)
    j = submit(env, path, {"hold": False}, preset="Cardstock (bypass)")
    wait_state(env, j["id"], "sent")
    ps = printed(env, "card.pdf")
    assert (ps["InputSlot"], ps["MediaType"], ps["PageSize"]) == ("MultiTray", "Thick2", "Letter")


def test_special_paper_on_auto_tray_is_routed_to_bypass(env):
    path = env["files"] / "labels.pdf"
    shutil.copy(env["pdf_letter2"], path)
    j = submit(env, path, {"PageSize": "Letter", "InputSlot": "Auto", "MediaType": "Labels"})
    held = wait_state(env, j["id"], "held")
    assert "Special paper" in held["message"]
    env["client"].post(f"/api/jobs/{j['id']}/cancel")
    assert wait_state(env, j["id"], "canceled")["can_reprint"] is True


def test_bw_two_sided_copies(env):
    j = submit(env, env["pdf_letter2"], {"ColorModel": "Gray", "Duplex": "DuplexNoTumble", "copies": 3})
    wait_state(env, j["id"], "sent")
    ps = printed(env, "two pages.pdf")
    assert ps["ColorModel"] == "Gray"
    assert ps["Duplex"] == "DuplexNoTumble"
    assert ps["NumCopies"] == "3"
    assert ps["Collate"] == "True"


def test_locked_print_pin_and_files_are_deleted(env):
    path = env["files"] / "private.pdf"
    shutil.copy(env["pdf_letter2"], path)
    j = submit(env, path, {"pin": "4321"})
    done = wait_state(env, j["id"], "sent")
    assert done["settings"]["pin"] is True and done["can_reprint"] is False
    ps = printed(env, "private.pdf")
    assert ps["JobType"] == "LockedPrint" and ps["lppswd"] == "4321"
    assert not (env["cfg"].spool_dir / j["id"]).exists()


def test_image_and_text_print(env):
    from PIL import Image

    img = env["files"] / "photo.jpg"
    Image.new("RGB", (1600, 1200), (30, 120, 200)).save(img)
    txt = env["files"] / "notes.txt"
    txt.write_text("Call sheet\nScene 4\n")
    a = submit(env, img)
    b = submit(env, txt)
    assert wait_state(env, a["id"], "sent")["pages"] == 1
    wait_state(env, b["id"], "sent")
    assert printed(env, "photo.jpg")["PageSize"] == "Letter"
    printed(env, "notes.txt")


@pytest.mark.skipif(not shutil.which("soffice"), reason="LibreOffice not installed")
def test_word_document_is_converted(env):
    src = env["files"] / "memo.txt"
    src.write_text("Memo\n\nThis started life as a Word document.\n")
    subprocess.run(["soffice", "--headless", "--convert-to", "docx", "--outdir", str(env["files"]), str(src)],
                   check=True, capture_output=True, timeout=120, env=dict(os.environ, HOME=str(env["files"])))
    j = submit(env, env["files"] / "memo.docx")
    done = wait_state(env, j["id"], "sent", "held", "failed", timeout=150)
    assert done["state"] == "sent", done
    assert done["pages"] == 1
    # LibreOffice saves A4 by default; "match the file" should use Letter, not hold for A4.
    assert done["page_size"] == "Letter"
    assert printed(env, "memo.docx")["PageSize"] == "Letter"


def test_unprintable_file_fails_clearly(env):
    bad = env["files"] / "archive.zip"
    bad.write_bytes(b"PK\x03\x04 not really")
    j = submit(env, bad)
    failed = wait_state(env, j["id"], "failed")
    assert ".zip" in failed["message"] and failed["can_reprint"] is False


def test_bad_settings_are_rejected(env):
    with open(env["pdf_tabloid"], "rb") as fh:
        r = env["client"].post("/api/jobs", files={"files": ("x.pdf", fh)}, data={"settings": '{"InputSlot": "9Tray"}'})
    assert r.status_code == 400 and "Tray" in r.json()["detail"]


def test_reprint(env):
    path = env["files"] / "again.pdf"
    shutil.copy(env["pdf_tabloid"], path)
    first = submit(env, path)
    wait_state(env, first["id"], "sent")
    r = env["client"].post(f"/api/jobs/{first['id']}/reprint", data={"user": "Sam"})
    assert r.status_code == 200
    second = wait_state(env, r.json()["id"], "sent")
    assert second["source"] == "reprint" and second["user"] == "Sam"


def test_drop_folder(env):
    hot = env["app"].state.hot
    folder = env["cfg"].hot_dir / "Bypass - 13x10"
    assert folder.is_dir()
    assert (env["cfg"].hot_dir / "READ ME - how this works.txt").exists()
    target = folder / "dropped.pdf"
    shutil.copy(env["pdf_13x10"], target)
    (folder / ".DS_Store").write_bytes(b"junk")
    created = wait_for(lambda: hot.scan_once(), timeout=15, interval=0.5)
    held = wait_state(env, created[0], "held")
    assert held["source"] == "folder" and held["page_size"] == "10x13"
    assert not target.exists()
    assert (folder / ".DS_Store").exists()  # ignored, not printed
    env["client"].post(f"/api/jobs/{created[0]}/release")
    wait_state(env, created[0], "sent")
    assert printed(env, "dropped.pdf")["usrid"] == "folder"


def test_status_and_pages(env):
    c = env["client"]
    assert c.get("/healthz").status_code == 200
    status = c.get("/api/status").json()
    assert status["queue"]["ok"] is True
    config = c.get("/api/config").json()
    assert "10x13" in [s["id"] for s in config["page_sizes"]]
    assert config["bypass"]["tray"] == "MultiTray"
    page = c.get("/").text
    assert "PrintDrop" in page
    sign = c.get("/sign").text
    assert "13 × 10, cardstock" in sign and "<svg" in sign and "smb://" in sign


def test_lpd_queue_with_queue_name(env):
    """The office Macs print over LPD to a named queue; make sure that works too."""
    from printdrop.printer import setup_queue

    cfg = env["cfg"]
    uri = f"lpd://127.0.0.1:{env['lpd_port']}/OFFICE-QUEUE"
    setup_queue(cfg, uri)
    try:
        path = env["files"] / "via lpd.pdf"
        shutil.copy(env["pdf_tabloid"], path)
        j = submit(env, path)
        wait_state(env, j["id"], "sent")
        ps = printed(env, "via lpd.pdf")
        assert ps["PageSize"] == "Tabloid"
        queues = [p.read_text() for p in env["out"].glob("*.queue")]
        assert "OFFICE-QUEUE" in queues
    finally:
        setup_queue(cfg, f"socket://127.0.0.1:{env['raw_port']}")


def test_unreachable_printer_is_reported_and_retried(env):
    from printdrop.printer import setup_queue

    cfg = env["cfg"]
    setup_queue(cfg, f"socket://127.0.0.1:{_free_port()}")
    try:
        path = env["files"] / "offline.pdf"
        shutil.copy(env["pdf_tabloid"], path)
        j = submit(env, path)
        stuck = wait_for(lambda: (x := job(env, j["id"]))["message"] and "reach" in x["message"] and x, timeout=60)
        assert stuck["state"] in ("queued", "printing") and stuck["can_cancel"]
        # The queue must still be enabled (retry-job), not stopped.
        assert env["client"].get("/api/status").json()["queue"]["state"] != "stopped"
        env["client"].post(f"/api/jobs/{j['id']}/cancel")
        wait_state(env, j["id"], "canceled")
    finally:
        setup_queue(cfg, f"socket://127.0.0.1:{env['raw_port']}")
