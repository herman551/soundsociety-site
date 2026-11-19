"""Web page + JSON API."""

from __future__ import annotations

import html
import io
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import convert, printer
from . import settings as S
from .config import PACKAGE_DIR, Config, load_config
from .hotfolder import HotFolders
from .service import PrintService

log = logging.getLogger("printdrop.app")
STATIC_DIR = PACKAGE_DIR / "static"


def create_app(cfg: Config | None = None, *, start_background: bool = True) -> FastAPI:
    cfg = cfg or load_config()
    service = PrintService(cfg)
    hot = HotFolders(service)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if start_background:
            service.start()
            hot.start()
        yield
        service.stop()
        hot.stop()

    app = FastAPI(title="PrintDrop", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.service = service
    app.state.hot = hot
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    def job_json(job) -> dict:
        data = service.public_job(job)
        if data["bypass"]:
            sizes = {p["id"]: p.get("label", p["id"]) for p in cfg.page_sizes}
            media = {m["id"]: m.get("label", m["id"]) for m in cfg.media_types}
            sheet = service.paper.get(job.page_size or "")
            data["load"] = {
                "size": sizes.get(job.page_size or "", job.page_size),
                "media": media.get(job.settings.get("MediaType", "Auto"), "Plain paper"),
                "feed_edge_in": round(sheet.width / 72, 2) if sheet and sheet.cups_value.startswith("Custom.") else None,
            }
        return data

    # Pages -------------------------------------------------------------------
    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/sign", include_in_schema=False, response_class=HTMLResponse)
    def sign(request: Request):
        url = (cfg.public_url or str(request.base_url)).rstrip("/")
        host = request.url.hostname or "printdrop"
        qr_svg = ""
        try:
            import qrcode
            import qrcode.image.svg

            img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=12, border=2)
            buf = io.BytesIO()
            img.save(buf)
            qr_svg = buf.getvalue().decode("utf-8")
            qr_svg = qr_svg[qr_svg.index("<svg"):]
        except Exception as exc:  # qrcode not installed: the sign still works
            log.info("No QR code on sign: %s", exc)
        template = (STATIC_DIR / "sign.html").read_text(encoding="utf-8")
        smb = ""
        if cfg.smb_enabled:
            share = html.escape(cfg.share_name)
            smb = (f'<section class="folders"><h2>Or drop files into a folder</h2>'
                   f'<p>Mac: Finder → Go → Connect to Server → <code>smb://{html.escape(host)}/{share}</code></p>'
                   f'<p>Windows: File Explorer address bar → <code>\\\\{html.escape(host)}\\{share}</code></p>'
                   f'<p>Each folder prints with different settings. The file disappears once it\'s sent.</p></section>')
        usual = next((t.get("usual") for t in cfg.trays if t.get("bypass") and t.get("usual")), None)
        usual_label = next((p.get("label", p["id"]) for p in cfg.page_sizes if p["id"] == usual), None)
        bypass_paper = f"{usual_label.split(' (')[0]}, cardstock or anything else" if usual_label else "cardstock or anything else"
        page = (template
                .replace("{{BYPASS_PAPER}}", html.escape(bypass_paper))
                .replace("{{URL}}", html.escape(url))
                .replace("{{QR}}", qr_svg)
                .replace("{{PRINTER}}", html.escape(cfg.display_name))
                .replace("{{SMB}}", smb))
        return HTMLResponse(page)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        queue = printer.queue_status(cfg)
        return JSONResponse({"ok": queue.get("ok", False), "queue": queue}, status_code=200 if queue.get("ok") else 503)

    # API ---------------------------------------------------------------------
    @app.get("/api/config")
    def api_config():
        sizes = []
        for entry in cfg.page_sizes:
            sheet = service.paper.get(entry["id"])
            if not sheet:
                continue
            sizes.append({
                "id": entry["id"], "label": entry.get("label", entry["id"]),
                "drawer": entry["id"] in cfg.drawer_sizes,
                "custom": sheet.cups_value.startswith("Custom."),
                "feed_edge_in": round(sheet.width / 72, 2),
            })
        size_labels = {p["id"]: p.get("label", p["id"]) for p in cfg.page_sizes}
        trays = []
        for tray in cfg.trays:
            if not service.ppd.has_choice("InputSlot", str(tray["id"])):
                continue
            item = {"id": tray["id"], "label": tray.get("label", tray["id"]), "bypass": bool(tray.get("bypass"))}
            note = tray.get("note")
            if tray.get("paper"):
                note = note or size_labels.get(tray["paper"], tray["paper"])
                item["paper"] = tray["paper"]
            if tray.get("usual"):
                item["usual"] = tray["usual"]
            item["note"] = note or ""
            trays.append(item)
        media = [m for m in cfg.media_types if service.ppd.has_choice("MediaType", str(m["id"]))]
        defaults = S.resolve(cfg, service.ppd).public_dict()
        return {
            "printer": {"name": cfg.display_name, "location": cfg.location, "web_url": cfg.web_url},
            "page_sizes": sizes,
            "trays": trays,
            "media_types": media,
            "presets": [{"name": p.get("name"), "folder": p.get("folder"), "settings": p.get("settings") or {}}
                        for p in cfg.presets],
            "defaults": defaults,
            "bypass": {"tray": cfg.bypass_tray, **cfg.bypass},
            "drawer_sizes": sorted(cfg.drawer_sizes),
            "extensions": convert.supported_extensions(),
            "office": convert.office_available(),
            "max_upload_mb": cfg.max_upload_bytes // (1024 * 1024),
            "smb": {"enabled": cfg.smb_enabled, "share": cfg.share_name},
        }

    @app.get("/api/status")
    def api_status():
        from . import jobs as J

        held = service.store.with_states({J.HELD})
        return {
            "queue": printer.queue_status(cfg),
            "device": service.device.status.as_dict(),
            "held": len(held),
        }

    @app.get("/api/jobs")
    def api_jobs(limit: int = 40):
        return {"jobs": [job_json(j) for j in service.store.recent(max(1, min(limit, 200)))]}

    @app.post("/api/jobs")
    async def api_submit(
        files: list[UploadFile] = File(...),
        settings: str = Form("{}"),
        preset: str = Form(""),
        user: str = Form(""),
    ):
        try:
            picked = json.loads(settings or "{}")
            if not isinstance(picked, dict):
                raise ValueError
        except ValueError:
            raise HTTPException(400, "Settings weren't readable.") from None
        preset_settings = None
        if preset:
            match = next((p for p in cfg.presets if p.get("name") == preset), None)
            if match is None:
                raise HTTPException(400, f"No preset called “{preset}”.")
            preset_settings = match.get("settings")
        try:
            job_settings = S.resolve(cfg, service.ppd, preset_settings, picked)
        except S.SettingsError as exc:
            raise HTTPException(400, str(exc)) from None

        created = []
        for upload in files:
            name = upload.filename or "document"
            staged = service.new_upload_path(name)
            size = 0
            too_big = False
            with open(staged, "wb") as out:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > cfg.max_upload_bytes:
                        too_big = True
                        break
                    out.write(chunk)
            if too_big:
                staged.unlink(missing_ok=True)
                raise HTTPException(413, f"“{name}” is bigger than {cfg.max_upload_bytes // (1024 * 1024)} MB.")
            if size == 0:
                staged.unlink(missing_ok=True)
                raise HTTPException(400, f"“{name}” is empty.")
            job = service.add_job(staged, filename=name, user=user, source="web",
                                  settings=job_settings, preset=preset or None)
            created.append(job_json(job))
        return {"jobs": created}

    def _job_or_404(job_id: str):
        job = service.store.get(job_id)
        if not job:
            raise HTTPException(404, "No such job.")
        return job

    @app.post("/api/jobs/{job_id}/release")
    def api_release(job_id: str):
        _job_or_404(job_id)
        return job_json(service.release(job_id))

    @app.post("/api/jobs/{job_id}/cancel")
    def api_cancel(job_id: str):
        _job_or_404(job_id)
        return job_json(service.cancel(job_id))

    @app.post("/api/jobs/{job_id}/reprint")
    def api_reprint(job_id: str, user: str = Form("")):
        _job_or_404(job_id)
        job = service.reprint(job_id, user or None)
        if not job:
            raise HTTPException(410, "That file has been deleted, so it can't be reprinted.")
        return job_json(job)

    return app
