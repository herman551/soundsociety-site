"""PrintDrop's own record of jobs: who sent what, with which settings, and
where it got to. CUPS only knows about a job once it's been handed over."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

# Job states, in the order a job normally moves through them.
RECEIVED = "received"      # file saved, waiting its turn
PREPARING = "preparing"    # converting / measuring
QUEUED = "queued"          # handed to CUPS, waiting
PRINTING = "printing"      # CUPS is sending it to the printer
HELD = "held"              # bypass job waiting for someone to load paper and release it
SENT = "sent"              # the printer accepted it
FAILED = "failed"
CANCELED = "canceled"

ACTIVE_STATES = {RECEIVED, PREPARING, QUEUED, PRINTING, HELD}
FINAL_STATES = {SENT, FAILED, CANCELED}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    created     REAL NOT NULL,
    updated     REAL NOT NULL,
    user        TEXT,
    source      TEXT NOT NULL,
    filename    TEXT NOT NULL,
    spool_path  TEXT,
    print_path  TEXT,
    settings    TEXT NOT NULL,
    summary     TEXT,
    state       TEXT NOT NULL,
    message     TEXT,
    pages       INTEGER,
    page_size   TEXT,
    cups_id     INTEGER,
    preset      TEXT
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
"""


@dataclass
class Job:
    id: str
    created: float
    updated: float
    user: str | None
    source: str
    filename: str
    spool_path: str | None
    print_path: str | None
    settings: dict
    summary: str | None
    state: str
    message: str | None
    pages: int | None
    page_size: str | None
    cups_id: int | None
    preset: str | None

    @property
    def active(self) -> bool:
        return self.state in ACTIVE_STATES

    def public(self) -> dict:
        settings = dict(self.settings)
        settings["pin"] = bool(settings.get("pin"))
        return {
            "id": self.id,
            "created": self.created,
            "updated": self.updated,
            "user": self.user,
            "source": self.source,
            "filename": self.filename,
            "settings": settings,
            "summary": self.summary,
            "state": self.state,
            "message": self.message,
            "pages": self.pages,
            "page_size": self.page_size,
            "preset": self.preset,
            "can_cancel": self.active,
            "can_release": self.state == HELD,
            # Reprint only what got as far as being printable.
            "can_reprint": bool(self.spool_path and self.print_path) and not settings["pin"]
                           and self.state in (SENT, FAILED, CANCELED),
        }


class JobStore:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)

    @staticmethod
    def _row(row: sqlite3.Row | None) -> Job | None:
        if row is None:
            return None
        data = dict(row)
        data["settings"] = json.loads(data["settings"])
        return Job(**data)

    def create(self, *, user: str | None, source: str, filename: str, spool_path: str,
               settings: dict, summary: str, preset: str | None = None) -> Job:
        now = time.time()
        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._db.execute(
                "INSERT INTO jobs (id, created, updated, user, source, filename, spool_path, settings,"
                " summary, state, preset) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, now, now, user, source, filename, spool_path, json.dumps(settings), summary,
                 RECEIVED, preset),
            )
        return self.get(job_id)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row(row)

    def update(self, job_id: str, **fields) -> None:
        if not fields:
            return
        if "settings" in fields:
            fields["settings"] = json.dumps(fields["settings"])
        fields["updated"] = time.time()
        columns = ", ".join(f"{key} = ?" for key in fields)
        with self._lock:
            self._db.execute(f"UPDATE jobs SET {columns} WHERE id = ?", (*fields.values(), job_id))

    def recent(self, limit: int = 50) -> list[Job]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM jobs ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        return [self._row(r) for r in rows]

    def with_states(self, states: set[str]) -> list[Job]:
        marks = ",".join("?" for _ in states)
        with self._lock:
            rows = self._db.execute(
                f"SELECT * FROM jobs WHERE state IN ({marks}) ORDER BY created", tuple(states)
            ).fetchall()
        return [self._row(r) for r in rows]

    def expired_files(self, older_than: float) -> list[Job]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM jobs WHERE spool_path IS NOT NULL AND created < ? AND state IN (?,?,?)",
                (older_than, SENT, FAILED, CANCELED),
            ).fetchall()
        return [self._row(r) for r in rows]

    def prune(self, older_than: float) -> None:
        with self._lock:
            self._db.execute("DELETE FROM jobs WHERE created < ? AND spool_path IS NULL", (older_than,))
