"""Everything that talks to CUPS (the local print spooler) and to the Ricoh
itself."""

from __future__ import annotations

import logging
import socket
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

import cups

from .config import Config

log = logging.getLogger("printdrop.printer")

# IPP job-state values
_JOB_PENDING, _JOB_HELD, _JOB_PROCESSING, _JOB_STOPPED = 3, 4, 5, 6
_JOB_CANCELED, _JOB_ABORTED, _JOB_COMPLETED = 7, 8, 9

# Ricoh paths for IPP, newest first (IM series answer on /ipp/print).
_IPP_PATHS = ("/ipp/print", "/printer", "/ipp")


# ---------------------------------------------------------------------------
# Finding the printer
# ---------------------------------------------------------------------------

def port_open(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def detect_uri(host: str) -> str | None:
    """Pick the most dependable way to send PostScript to a Ricoh.

    Raw port 9100 is preferred: no queue names to get wrong, and the Ricoh
    takes the job as soon as it arrives. LPD and IPP are fallbacks for
    networks where 9100 is blocked."""
    if port_open(host, 9100):
        return f"socket://{host}:9100"
    if port_open(host, 515):
        return f"lpd://{host}/lp"
    if port_open(host, 631):
        return f"ipp://{host}{_IPP_PATHS[0]}"
    return None


_DEFAULT_PORTS = {"socket": 9100, "lpd": 515, "ipp": 631, "ipps": 631, "http": 631}


def uri_reachable(uri: str) -> bool:
    parsed = urlparse(uri)
    if not parsed.hostname:
        return False
    return port_open(parsed.hostname, parsed.port or _DEFAULT_PORTS.get(parsed.scheme, 9100))


def resolve_uri(cfg: Config) -> str | None:
    """Try each PRINTER entry in order and return the first that answers.
    If none answers right now, fall back to the first entry: CUPS keeps
    retrying until the printer is reachable."""
    first: str | None = None
    for target in cfg.printer_targets:
        if "://" in target:
            uri = target
            ok = uri_reachable(uri)
        else:
            uri = detect_uri(target)
            ok = uri is not None
            uri = uri or f"socket://{target}:9100"
        first = first or uri
        if ok:
            log.info("Printer answers at %s", uri)
            return uri
        log.warning("No answer from %s", target)
    if first:
        log.warning("Nothing answered; using %s and letting CUPS keep retrying", first)
    return first


def queue_device_uri(cfg: Config) -> str | None:
    try:
        attrs = connect().getPrinterAttributes(cfg.queue, requested_attributes=["device-uri"])
        return attrs.get("device-uri")
    except (cups.IPPError, RuntimeError):
        return None


def printer_host(cfg: Config) -> str | None:
    """The host the queue actually prints to (for status checks)."""
    uri = queue_device_uri(cfg)
    if uri:
        return urlparse(uri).hostname
    for target in cfg.printer_targets:
        return urlparse(target).hostname if "://" in target else target
    return None


# ---------------------------------------------------------------------------
# CUPS queue
# ---------------------------------------------------------------------------

def connect() -> cups.Connection:
    return cups.Connection()


def setup_queue(cfg: Config, uri: str) -> None:
    """Create or update the CUPS queue. Needs CUPS admin rights (root)."""
    conn = connect()
    conn.addPrinter(
        cfg.queue,
        filename=str(cfg.ppd_path),
        device=uri,
        info=cfg.display_name,
        location=cfg.location,
    )
    for option, value in cfg.installed.items():
        conn.addPrinterOptionDefault(cfg.queue, option, value)
    # Never let one failed job switch the queue off. "stop-printer" is the
    # CUPS default and one of the classic reasons a printer "stops working".
    conn.setPrinterErrorPolicy(cfg.queue, "retry-job")
    conn.setPrinterShared(cfg.queue, False)
    conn.enablePrinter(cfg.queue)
    conn.acceptJobs(cfg.queue)
    log.info("CUPS queue %r -> %s", cfg.queue, uri)


@dataclass
class CupsJob:
    state: int
    reasons: list[str] = field(default_factory=list)
    message: str = ""


def submit(cfg: Config, path: str, title: str, options: dict[str, str]) -> int:
    return connect().printFile(cfg.queue, path, title[:120] or "PrintDrop job", options)


def job_status(job_id: int) -> CupsJob | None:
    try:
        attrs = connect().getJobAttributes(
            job_id, requested_attributes=["job-state", "job-state-reasons", "job-printer-state-message"]
        )
    except cups.IPPError:
        return None
    reasons = attrs.get("job-state-reasons") or []
    if isinstance(reasons, str):
        reasons = [reasons]
    return CupsJob(int(attrs.get("job-state", 0)), list(reasons), attrs.get("job-printer-state-message") or "")


def cancel(job_id: int) -> None:
    try:
        connect().cancelJob(job_id, purge_job=False)
    except cups.IPPError as exc:
        log.info("Cancel of CUPS job %s: %s", job_id, exc)


def queue_status(cfg: Config) -> dict:
    """State of the local CUPS queue (not the Ricoh itself)."""
    try:
        conn = connect()
        attrs = conn.getPrinterAttributes(
            cfg.queue,
            requested_attributes=["printer-state", "printer-state-message", "printer-state-reasons",
                                  "printer-is-accepting-jobs", "device-uri"],
        )
    except (cups.IPPError, RuntimeError) as exc:
        return {"ok": False, "state": "missing", "message": f"Print queue isn't set up ({exc})."}
    state = {3: "idle", 4: "processing", 5: "stopped"}.get(attrs.get("printer-state"), "unknown")
    reasons = attrs.get("printer-state-reasons") or []
    if isinstance(reasons, str):
        reasons = [reasons]
    return {
        "ok": True,
        "state": state,
        "message": attrs.get("printer-state-message") or "",
        "reasons": [r for r in reasons if r != "none"],
        "accepting": bool(attrs.get("printer-is-accepting-jobs", True)),
    }


def keep_queue_running(cfg: Config) -> None:
    """Switch the queue back on if anything switched it off."""
    try:
        conn = connect()
        attrs = conn.getPrinterAttributes(cfg.queue, requested_attributes=["printer-state",
                                                                            "printer-is-accepting-jobs"])
        if attrs.get("printer-state") == 5:
            log.warning("CUPS queue was stopped; starting it again")
            conn.enablePrinter(cfg.queue)
        if not attrs.get("printer-is-accepting-jobs", True):
            conn.acceptJobs(cfg.queue)
    except (cups.IPPError, RuntimeError) as exc:
        log.debug("keep_queue_running: %s", exc)


_UNREACHABLE = ("may not exist", "unavailable", "unable to connect", "unable to locate", "not responding",
                "is busy", "unreachable", "will retry", "connection refused", "waiting for printer to become")


def looks_unreachable(*messages: str | None) -> bool:
    text = " ".join(m for m in messages if m).lower()
    return any(k in text for k in _UNREACHABLE)


def map_cups_state(job: CupsJob, queue_message: str = "") -> tuple[str, str | None]:
    """Translate a CUPS job into PrintDrop state + a message for people.
    ``queue_message`` is the queue's own message: CUPS puts "can't reach the
    printer" there, not on the job."""
    from . import jobs as J

    message = job.message or None
    if job.state == _JOB_COMPLETED:
        return J.SENT, None
    if job.state == _JOB_CANCELED:
        return J.CANCELED, None
    if job.state == _JOB_ABORTED:
        return J.FAILED, message or "The print system gave up on this job."
    if job.state == _JOB_HELD:
        return J.QUEUED, "Waiting in line"
    if job.state == _JOB_PROCESSING:
        if looks_unreachable(job.message, queue_message):
            return J.PRINTING, "Can't reach the printer, retrying…"
        if any(r.startswith("connecting-to-device") for r in job.reasons):
            return J.PRINTING, "Connecting to the printer…"
        return J.PRINTING, "Sending to the printer…"
    if job.state in (_JOB_STOPPED, _JOB_PENDING) and looks_unreachable(job.message):
        return J.QUEUED, "Can't reach the printer, retrying…"
    return J.QUEUED, "Waiting in line"


# ---------------------------------------------------------------------------
# The Ricoh's own status, over IPP (best effort: many networks block it)
# ---------------------------------------------------------------------------

# printer-state-reasons keywords -> what to tell people.
_REASONS = {
    "media-needed": "The printer is waiting for paper to be loaded.",
    "media-empty": "A paper tray is empty.",
    "media-low": "A paper tray is running low.",
    "media-jam": "Paper jam. Follow the steps on the printer's screen to clear it.",
    "input-tray-missing": "A paper drawer is open or missing.",
    "door-open": "A printer door or cover is open.",
    "cover-open": "A printer door or cover is open.",
    "toner-empty": "Out of toner.",
    "toner-low": "Toner is low.",
    "marker-supply-empty": "Out of toner.",
    "marker-supply-low": "Toner is low.",
    "marker-waste-full": "The waste toner bottle is full.",
    "marker-waste-almost-full": "The waste toner bottle is nearly full.",
    "output-area-full": "The output tray is full. Take the paper out.",
    "spool-area-full": "The printer's memory is full.",
    "paused": "The printer is paused.",
    "offline": "The printer is offline.",
    "shutdown": "The printer is off.",
    "other": "",
}


@dataclass
class DeviceStatus:
    reachable: bool = False
    state: str = "unknown"          # idle | processing | stopped | unknown
    alerts: list[dict] = field(default_factory=list)   # [{"level": "error|warning", "text": ...}]
    trays: list[dict] = field(default_factory=list)    # [{"name", "level", "status"}]
    toner: list[dict] = field(default_factory=list)    # [{"name", "level", "color"}]
    checked: float = 0.0

    def as_dict(self) -> dict:
        return {
            "reachable": self.reachable,
            "state": self.state,
            "alerts": self.alerts,
            "trays": self.trays,
            "toner": self.toner,
            "checked": self.checked,
        }


def _parse_input_trays(values) -> list[dict]:
    """IPP printer-input-tray values look like
    'type=sheetFeedManual;mediafeed=0;...;level=-2;status=0;name=Bypass Tray;'."""
    trays = []
    for raw in values or []:
        text = raw.decode("latin-1", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        fields = {}
        for part in text.split(";"):
            if "=" in part:
                key, value = part.split("=", 1)
                fields[key.strip()] = value.strip()
        try:
            level = int(fields.get("level", "-2"))
            maximum = int(fields.get("maxcapacity", "-2"))
        except ValueError:
            level, maximum = -2, -2
        if level == 0:
            status = "empty"
        elif level == -3 or level > 0:
            status = "ok"
            if maximum > 0 and 0 < level <= maximum * 0.1:
                status = "low"
        else:
            status = "unknown"
        trays.append({"name": fields.get("name") or fields.get("type", "Tray"), "level": level, "status": status})
    return trays


class DeviceMonitor:
    """Polls the Ricoh over IPP in the background so page loads stay fast."""

    def __init__(self, host: str | None, interval: float = 20.0):
        self.host = host
        self.interval = interval
        self.status = DeviceStatus()
        self._path: str | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        if not self.host:
            return
        threading.Thread(target=self._run, name="device-monitor", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.status = self.poll()
            except Exception as exc:  # never let the monitor die
                log.debug("Device poll failed: %s", exc)
                self.status = DeviceStatus(checked=time.time())
            self._stop.wait(self.interval)

    def poll(self) -> DeviceStatus:
        if not self.host or not port_open(self.host, 631, timeout=2):
            return DeviceStatus(checked=time.time())
        conn = cups.Connection(host=self.host, port=631)
        wanted = ["printer-state", "printer-state-reasons", "printer-input-tray",
                  "marker-names", "marker-levels", "marker-colors"]
        attrs = None
        for path in ([self._path] if self._path else []) + [p for p in _IPP_PATHS if p != self._path]:
            try:
                attrs = conn.getPrinterAttributes(uri=f"ipp://{self.host}{path}", requested_attributes=wanted)
                self._path = path
                break
            except cups.IPPError:
                continue
        if attrs is None:
            return DeviceStatus(checked=time.time())

        status = DeviceStatus(reachable=True, checked=time.time())
        status.state = {3: "idle", 4: "processing", 5: "stopped"}.get(attrs.get("printer-state"), "unknown")
        reasons = attrs.get("printer-state-reasons") or []
        if isinstance(reasons, str):
            reasons = [reasons]
        seen = set()
        for reason in reasons:
            if reason == "none":
                continue
            level = "error" if reason.endswith("-error") else "warning" if reason.endswith("-warning") else "info"
            base = reason.rsplit("-", 1)[0] if level != "info" else reason
            text = _REASONS.get(base)
            if text is None or not text or text in seen:
                continue
            seen.add(text)
            if level == "info":
                level = "error" if base in ("media-needed", "media-jam", "door-open", "cover-open") else "warning"
            status.alerts.append({"level": level, "text": text, "reason": reason})
        status.trays = _parse_input_trays(attrs.get("printer-input-tray"))
        names = attrs.get("marker-names") or []
        levels = attrs.get("marker-levels") or []
        colors = attrs.get("marker-colors") or []
        if isinstance(names, str):
            names, levels, colors = [names], [levels], [colors]
        for i, name in enumerate(names):
            status.toner.append({
                "name": name,
                "level": levels[i] if i < len(levels) else -1,
                "color": colors[i] if i < len(colors) else "",
            })
        return status
