"""Loads printdrop.yml plus the environment variables that hold anything
site-specific (printer address, user code).

Environment:
  PRINTER            where the printer is: one or more IP addresses or CUPS
                     device URIs (socket://, lpd://, ipp://), separated by
                     spaces or commas. The first one that answers is used.
                     A bare address means "work out the protocol".
  PRINTER_USER_CODE  Ricoh user code, if the printer requires one
  PRINTER_QUEUE      CUPS queue name (default "ricoh")
  PRINTDROP_DATA     where jobs, uploads and drop folders live (default /data)
  PRINTDROP_CONFIG   path to printdrop.yml
  SMB_ENABLED        "1" when the drop folders are shared over the network
  SMB_SHARE_NAME     share name shown to people (default "PrintDrop")
  PORT               web port inside the container (default 8080)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _env_flag(name: str, default: bool = False) -> bool:
    value = _env(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Config:
    raw: dict
    config_path: Path
    data_dir: Path
    ppd_path: Path
    queue: str
    printer_targets: list[str]
    user_code: str | None
    share_name: str
    smb_enabled: bool
    smb_user: str | None
    public_url: str | None
    port: int

    # Paths -----------------------------------------------------------------
    @property
    def spool_dir(self) -> Path:
        return self.data_dir / "spool"

    @property
    def hot_dir(self) -> Path:
        return self.data_dir / "hotfolders"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "printdrop.sqlite3"

    # Sections ----------------------------------------------------------------
    @property
    def printer(self) -> dict:
        return self.raw.get("printer") or {}

    @property
    def display_name(self) -> str:
        return self.printer.get("display_name") or "Printer"

    @property
    def location(self) -> str:
        return self.printer.get("location") or ""

    @property
    def web_url(self) -> str:
        return self.printer.get("web_url") or ""

    @property
    def installed(self) -> dict:
        return {k: str(v) for k, v in (self.printer.get("installed") or {}).items()}

    @property
    def job_defaults(self) -> dict:
        return dict(self.printer.get("job_defaults") or {})

    @property
    def trays(self) -> list[dict]:
        return list(self.raw.get("trays") or [])

    @property
    def bypass_tray(self) -> str:
        for tray in self.trays:
            if tray.get("bypass"):
                return str(tray["id"])
        return "MultiTray"

    @property
    def drawer_sizes(self) -> set[str]:
        """Paper sizes kept loaded in a drawer (not the bypass tray)."""
        return {str(t["paper"]) for t in self.trays if t.get("paper") and not t.get("bypass")}

    @property
    def bypass(self) -> dict:
        settings = {"hold_until_released": True, "hold_hours": 8, "auto_route": True}
        settings.update(self.raw.get("bypass") or {})
        return settings

    @property
    def page_sizes(self) -> list[dict]:
        return list(self.raw.get("page_sizes") or [])

    @property
    def media_types(self) -> list[dict]:
        return list(self.raw.get("media_types") or [])

    @property
    def presets(self) -> list[dict]:
        return list(self.raw.get("presets") or [])

    @property
    def fallback_page_size(self) -> str:
        return str(self.raw.get("fallback_page_size") or "Letter")

    @property
    def match_substitutes(self) -> dict[str, str]:
        return {str(k): str(v) for k, v in (self.raw.get("match_substitutes") or {}).items()}

    @property
    def retention_hours(self) -> float:
        return float(self.raw.get("retention_hours", 24))

    @property
    def max_upload_bytes(self) -> int:
        return int(float(self.raw.get("max_upload_mb", 200)) * 1024 * 1024)


def _default_config_path() -> Path:
    for candidate in (Path("/config/printdrop.yml"), PROJECT_DIR / "config" / "printdrop.yml"):
        if candidate.exists():
            return candidate
    return PROJECT_DIR / "config" / "printdrop.yml"


def load_config() -> Config:
    config_path = Path(_env("PRINTDROP_CONFIG") or _default_config_path())
    with open(config_path, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}

    ppd_default = PROJECT_DIR / "ppd" / "Ricoh-IM_C3510_PS.ppd"
    return Config(
        raw=raw,
        config_path=config_path,
        data_dir=Path(_env("PRINTDROP_DATA", "/data")),
        ppd_path=Path(_env("PRINTDROP_PPD", str(ppd_default))),
        queue=_env("PRINTER_QUEUE", "ricoh"),
        printer_targets=[t for t in re.split(r"[\s,]+", _env("PRINTER", "") or "") if t],
        user_code=_env("PRINTER_USER_CODE"),
        share_name=_env("SMB_SHARE_NAME", "PrintDrop"),
        smb_enabled=_env_flag("SMB_ENABLED", False),
        smb_user=_env("SMB_USER"),
        public_url=_env("PRINTDROP_PUBLIC_URL"),
        port=int(_env("PORT", "8080")),
    )
