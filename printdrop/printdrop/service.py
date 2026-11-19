"""The job pipeline: file in -> converted -> routed to the right tray ->
(held for bypass paper) -> CUPS -> printer. One worker thread does the
conversions so LibreOffice never runs twice at once."""

from __future__ import annotations

import logging
import queue
import re
import shutil
import threading
import time
from pathlib import Path

from . import jobs as J
from . import printer
from .config import Config
from .convert import ConvertError, match_page_size, prepare
from .jobs import Job, JobStore
from .ppd import load_ppd
from .settings import JobSettings, cups_options, describe, paper_table

log = logging.getLogger("printdrop.service")

_UNSAFE_NAME = re.compile(r"[\x00-\x1f/\\:*?\"<>|]+")


def safe_filename(name: str) -> str:
    name = Path(name.replace("\\", "/")).name
    name = _UNSAFE_NAME.sub("_", name).strip(" .") or "document"
    if len(name) > 150:
        stem, dot, ext = name.rpartition(".")
        name = (stem[:140] + dot + ext) if dot and len(ext) <= 8 else name[:150]
    return name


def clean_user(name: str | None) -> str | None:
    if not name:
        return None
    name = re.sub(r"[\x00-\x1f]", "", name).strip()[:40]
    return name or None


class PrintService:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.ppd = load_ppd(str(cfg.ppd_path))
        cfg.spool_dir.mkdir(parents=True, exist_ok=True)
        self.store = JobStore(cfg.db_path)
        self.device = printer.DeviceMonitor(printer.printer_host(cfg))
        self._work: queue.Queue[tuple[str, str]] = queue.Queue()
        self._stop = threading.Event()
        self.paper = paper_table(cfg, self.ppd)
        # Paper sizes people can pick, with their dimensions, for matching files.
        self.menu_sizes = {p["id"]: (self.paper[p["id"]].width, self.paper[p["id"]].height)
                           for p in cfg.page_sizes if p["id"] in self.paper}

    # Lifecycle ---------------------------------------------------------------
    def start(self) -> None:
        # Pick up anything that was mid-flight when PrintDrop last stopped.
        for job in self.store.with_states({J.RECEIVED, J.PREPARING}):
            self.store.update(job.id, state=J.RECEIVED)
            self._work.put(("prepare", job.id))
        threading.Thread(target=self._worker, name="job-worker", daemon=True).start()
        threading.Thread(target=self._sync_loop, name="job-sync", daemon=True).start()
        self.device.start()

    def stop(self) -> None:
        self._stop.set()
        self.device.stop()

    # Adding jobs ---------------------------------------------------------------
    def job_dir(self, job_id: str) -> Path:
        return self.cfg.spool_dir / job_id

    def new_upload_path(self, filename: str) -> Path:
        """A fresh place to save an incoming file before the job exists."""
        staging = self.cfg.spool_dir / "incoming" / f"{time.time_ns()}"
        staging.mkdir(parents=True, exist_ok=True)
        return staging / safe_filename(filename)

    def add_job(self, staged: Path, *, filename: str, user: str | None, source: str,
                settings: JobSettings, preset: str | None = None) -> Job:
        job = self.store.create(
            user=clean_user(user), source=source, filename=safe_filename(filename), spool_path=None,
            settings=settings.to_dict(), summary=describe(settings, None, self.cfg), preset=preset,
        )
        original = self.job_dir(job.id) / "original" / safe_filename(filename)
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staged), original)
        if staged.parent.name.isdigit() and staged.parent.parent.name == "incoming":
            shutil.rmtree(staged.parent, ignore_errors=True)
        self.store.update(job.id, spool_path=str(original))
        self._work.put(("prepare", job.id))
        return self.store.get(job.id)

    # Actions from the page -------------------------------------------------------
    def release(self, job_id: str) -> Job | None:
        job = self.store.get(job_id)
        if job and job.state == J.HELD:
            self.store.update(job_id, state=J.QUEUED, message="Sending to the printer…")
            self._work.put(("submit", job_id))
        return self.store.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        job = self.store.get(job_id)
        if not job or not job.active:
            return job
        if job.cups_id:
            printer.cancel(job.cups_id)
        self.store.update(job_id, state=J.CANCELED, message=None)
        return self.store.get(job_id)

    def reprint(self, job_id: str, user: str | None = None) -> Job | None:
        job = self.store.get(job_id)
        if not job or not job.spool_path or not Path(job.spool_path).exists() or job.settings.get("pin"):
            return None
        staged = self.new_upload_path(job.filename)
        shutil.copy2(job.spool_path, staged)
        settings = JobSettings(**job.settings)
        settings.hold = None
        return self.add_job(staged, filename=job.filename, user=user or job.user, source="reprint",
                            settings=settings, preset=job.preset)

    # Worker ----------------------------------------------------------------
    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                action, job_id = self._work.get(timeout=1)
            except queue.Empty:
                continue
            try:
                if action == "prepare":
                    self._prepare(job_id)
                elif action == "submit":
                    self._submit(job_id)
            except Exception as exc:
                log.exception("Job %s failed during %s", job_id, action)
                self.store.update(job_id, state=J.FAILED, message=f"Something went wrong: {exc}")

    def resolve_route(self, settings: JobSettings, size_pts) -> tuple[str, str, str | None]:
        """Decide paper size and tray. Returns (page_size, tray, note)."""
        page_size = settings.PageSize
        note = None
        if page_size == "auto":
            matched = match_page_size(size_pts, self.menu_sizes)
            substitute = self.cfg.match_substitutes.get(matched or "")
            if substitute and substitute in self.paper:
                note = f"{matched} file, printed on {substitute} (scaled to fit)."
                matched = substitute
            page_size = matched or self.cfg.fallback_page_size
        tray = settings.InputSlot
        if tray == "Auto" and self.cfg.bypass.get("auto_route", True):
            if self.cfg.drawer_sizes and page_size not in self.cfg.drawer_sizes:
                tray = self.cfg.bypass_tray
                note = "None of the drawers holds this paper size, so it goes to the bypass tray."
            elif settings.MediaType != "Auto":
                tray = self.cfg.bypass_tray
                note = "Special paper goes through the bypass tray."
        return page_size, tray, note

    def is_bypass(self, tray: str) -> bool:
        return tray == self.cfg.bypass_tray

    def bypass_instructions(self, job: Job) -> str:
        sizes = {p["id"]: p.get("label", p["id"]) for p in self.cfg.page_sizes}
        media = {m["id"]: m.get("label", m["id"]) for m in self.cfg.media_types}
        size_id = job.page_size or ""
        size = sizes.get(size_id, size_id or "the").split(" (")[0]
        media_id = job.settings.get("MediaType", "Auto")
        paper = "plain paper" if media_id == "Auto" else media.get(media_id, media_id)
        text = f"Load {size} {paper} in the bypass tray"
        sheet = self.paper.get(size_id)
        if sheet and sheet.cups_value.startswith("Custom."):
            text += f", {sheet.width / 72:g}-inch edge going in first"
        return text + ", then tap Print now."

    def _prepare(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if not job or job.state != J.RECEIVED:
            return
        self.store.update(job_id, state=J.PREPARING, message="Getting it ready…")
        workdir = self.job_dir(job_id) / "work"
        workdir.mkdir(parents=True, exist_ok=True)
        try:
            prepared = prepare(Path(job.spool_path), workdir)
        except ConvertError as exc:
            self.store.update(job_id, state=J.FAILED, message=str(exc))
            return

        settings = JobSettings(**job.settings)
        page_size, tray, note = self.resolve_route(settings, prepared.size_pts)
        settings.InputSlot = tray
        resolved = settings.to_dict()
        self.store.update(
            job_id, print_path=str(prepared.path), pages=prepared.pages, page_size=page_size,
            settings=resolved, summary=describe(settings, page_size, self.cfg),
        )
        if self.store.get(job_id).state == J.CANCELED:
            return

        hold = settings.hold if settings.hold is not None else self.cfg.bypass.get("hold_until_released", True)
        if self.is_bypass(tray) and hold:
            job = self.store.get(job_id)
            message = self.bypass_instructions(job)
            if note:
                message = f"{note} {message}"
            self.store.update(job_id, state=J.HELD, message=message)
            return
        self._submit(job_id, note)

    def _submit(self, job_id: str, note: str | None = None) -> None:
        job = self.store.get(job_id)
        if not job or job.state not in (J.PREPARING, J.QUEUED, J.HELD):
            return
        settings = JobSettings(**job.settings)
        paper = self.paper[job.page_size or self.cfg.fallback_page_size]
        # Shows as the User ID in the Ricoh's job list (8 characters max).
        ricoh_user = "folder" if job.source == "folder" else (job.user or "guest")
        options = cups_options(settings, paper, self.cfg, ricoh_user)
        cups_id = printer.submit(self.cfg, job.print_path, job.filename, options)
        log.info("Job %s -> CUPS %s (%s) %s", job_id, cups_id, job.filename, job.summary)
        self.store.update(job_id, state=J.QUEUED, cups_id=cups_id, message=note or "Waiting in line")
        if settings.pin:
            # CUPS has its own copy now; don't keep confidential files around.
            self._delete_files(job_id)

    # Background sync ---------------------------------------------------------
    def _sync_loop(self) -> None:
        last_cleanup = 0.0
        last_queue_check = 0.0
        while not self._stop.is_set():
            try:
                self.sync_once()
                now = time.time()
                if now - last_queue_check > 30:
                    printer.keep_queue_running(self.cfg)
                    last_queue_check = now
                if now - last_cleanup > 600:
                    self.cleanup()
                    last_cleanup = now
            except Exception:
                log.exception("Sync loop error")
            self._stop.wait(2)

    def sync_once(self) -> None:
        active = self.store.with_states({J.QUEUED, J.PRINTING})
        queue_message = printer.queue_status(self.cfg).get("message", "") if active else ""
        for job in active:
            if not job.cups_id:
                continue
            status = printer.job_status(job.cups_id)
            if status is None:
                continue
            state, message = printer.map_cups_state(status, queue_message)
            if state != job.state or message != job.message:
                self.store.update(job.id, state=state, message=message)
        hold_hours = float(self.cfg.bypass.get("hold_hours", 8))
        cutoff = time.time() - hold_hours * 3600
        for job in self.store.with_states({J.HELD}):
            if job.updated < cutoff:
                self.store.update(job.id, state=J.CANCELED,
                                  message=f"Nobody tapped Print now within {hold_hours:g} hours.")

    def _delete_files(self, job_id: str) -> None:
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)
        self.store.update(job_id, spool_path=None, print_path=None)

    def cleanup(self) -> None:
        cutoff = time.time() - self.cfg.retention_hours * 3600
        for job in self.store.expired_files(cutoff):
            self._delete_files(job.id)
        self.store.prune(time.time() - 30 * 86400)
        incoming = self.cfg.spool_dir / "incoming"
        if incoming.exists():
            for entry in incoming.iterdir():
                if entry.stat().st_mtime < time.time() - 3600:
                    shutil.rmtree(entry, ignore_errors=True)

    # Read side -----------------------------------------------------------------
    def public_job(self, job: Job) -> dict:
        data = job.public()
        data["bypass"] = self.is_bypass(job.settings.get("InputSlot", ""))
        return data
