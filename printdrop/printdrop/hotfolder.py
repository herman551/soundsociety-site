"""Drop folders: one folder per preset on the network share. Anything saved
into a folder prints with that preset's settings, then disappears from the
folder. Files that can't be printed land in "_Could not print" with a note
saying why."""

from __future__ import annotations

import logging
import shutil
import threading
import time
from pathlib import Path

from . import settings as S
from .service import PrintService

log = logging.getLogger("printdrop.hotfolder")

FAILED_DIR = "_Could not print"
README_NAME = "READ ME - how this works.txt"
_IGNORE_PREFIXES = (".", "~$", "._", "~lock.")
_IGNORE_NAMES = {"Thumbs.db", "desktop.ini", ".DS_Store", README_NAME}
_IGNORE_SUFFIXES = (".tmp", ".part", ".crdownload", ".download", ".partial")
SETTLE_SECONDS = 3.0


def _ignored(path: Path) -> bool:
    name = path.name
    return (name in _IGNORE_NAMES or name.startswith(_IGNORE_PREFIXES)
            or name.lower().endswith(_IGNORE_SUFFIXES))


class HotFolders:
    def __init__(self, service: PrintService, interval: float = 2.0):
        self.service = service
        self.cfg = service.cfg
        self.root = self.cfg.hot_dir
        self.interval = interval
        self._seen: dict[Path, tuple[int, float, float]] = {}  # path -> (size, mtime, first seen stable)
        self._stop = threading.Event()
        self.folders: dict[str, dict] = {}

    def setup(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / FAILED_DIR).mkdir(exist_ok=True)
        lines = [
            "Drop a file into one of these folders and it prints with that folder's settings.",
            "The file disappears from the folder once it has been sent to the printer.",
            "",
            "Bypass-tray folders: the job waits until you load the paper and tap",
            "\"Print now\" on the PrintDrop web page (see the address on the sign by the printer).",
            "",
            f"If something can't be printed it moves to \"{FAILED_DIR}\" with a note explaining why.",
            "",
            "Folders:",
        ]
        for preset in self.cfg.presets:
            folder = preset.get("folder")
            if not folder:
                continue
            self.folders[folder] = preset
            (self.root / folder).mkdir(exist_ok=True)
            lines.append(f"  {folder}  ->  {preset.get('name', folder)}")
        (self.root / README_NAME).write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")

    def start(self) -> None:
        self.setup()
        threading.Thread(target=self._run, name="hot-folders", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.scan_once()
            except Exception:
                log.exception("Hot folder scan failed")
            self._stop.wait(self.interval)

    def scan_once(self, now: float | None = None) -> list[str]:
        """Check every folder; submit files that have stopped changing.
        Returns the job ids created (handy for tests)."""
        now = time.time() if now is None else now
        created: list[str] = []
        present: set[Path] = set()
        for folder, preset in self.folders.items():
            directory = self.root / folder
            if not directory.is_dir():
                directory.mkdir(parents=True, exist_ok=True)
                continue
            for path in directory.rglob("*"):
                if not path.is_file() or _ignored(path) or any(p.startswith(".") for p in path.relative_to(directory).parts):
                    continue
                present.add(path)
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                key = (stat.st_size, stat.st_mtime)
                previous = self._seen.get(path)
                if previous is None or previous[:2] != key:
                    self._seen[path] = (*key, now)
                    continue
                if now - previous[2] < SETTLE_SECONDS or stat.st_size == 0:
                    continue
                job_id = self._submit(path, preset)
                self._seen.pop(path, None)
                if job_id:
                    created.append(job_id)
        for stale in set(self._seen) - present:
            self._seen.pop(stale, None)
        return created

    def _submit(self, path: Path, preset: dict) -> str | None:
        try:
            job_settings = S.resolve(self.cfg, self.service.ppd, preset.get("settings"))
        except S.SettingsError as exc:
            self._fail(path, f"The folder's preset has a problem: {exc}")
            return None
        staged = self.service.new_upload_path(path.name)
        try:
            shutil.move(str(path), staged)
        except OSError as exc:  # still open on a Windows client, etc.
            log.info("Can't take %s yet: %s", path, exc)
            return None
        job = self.service.add_job(staged, filename=path.name, user="Drop folder", source="folder",
                                   settings=job_settings, preset=preset.get("name"))
        log.info("Drop folder %r: %s -> job %s", preset.get("folder"), path.name, job.id)
        return job.id

    def _fail(self, path: Path, reason: str) -> None:
        target = self.root / FAILED_DIR / path.name
        try:
            shutil.move(str(path), target)
            target.with_name(target.name + " - why.txt").write_text(reason + "\r\n", encoding="utf-8")
        except OSError:
            log.exception("Couldn't move %s to the failed folder", path)

    def report_failure(self, filename: str, reason: str) -> None:
        """Called when a drop-folder job fails later on (conversion, etc.)."""
        try:
            note = self.root / FAILED_DIR / f"{filename} - why.txt"
            note.write_text(reason + "\r\n", encoding="utf-8")
        except OSError:
            pass
