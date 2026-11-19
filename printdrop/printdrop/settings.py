"""Turns what someone picked on the page (or a hot folder's preset) into a
checked set of print settings, then into CUPS options for the Ricoh driver."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from .config import Config
from .ppd import PPDInfo

PPD_KEYS = ("InputSlot", "MediaType", "ColorModel", "Duplex", "RIPaperPolicy")
_FRIENDLY = {"InputSlot": "Tray", "MediaType": "Paper type", "ColorModel": "Color", "Duplex": "Sides",
             "RIPaperPolicy": "Paper mismatch"}
_PAGE_RANGES = re.compile(r"^\d+(-\d+)?(,\d+(-\d+)?)*$")
_PIN = re.compile(r"^\d{4,8}$")
_RICOH_USER_ID_CHARS = re.compile(r"[^0-9A-Za-z\-./:_]")


class SettingsError(ValueError):
    """A setting someone picked can't be used. The message is shown to them."""


@dataclass(frozen=True)
class Paper:
    width: float    # points; the edge that feeds into the printer first
    height: float
    cups_value: str  # what to send as the PageSize option


def paper_table(cfg: Config, ppd: PPDInfo) -> dict[str, Paper]:
    """Every paper size PrintDrop can ask for: the driver's own sizes plus
    custom sizes defined in printdrop.yml (e.g. 13 x 10)."""
    table = {name: Paper(w, h, name) for name, (w, h) in ppd.paper.items()}
    width_limits = ppd.custom_limits.get("Width")
    height_limits = ppd.custom_limits.get("Height")
    for entry in cfg.page_sizes:
        if "width_in" in entry:
            w, h = float(entry["width_in"]) * 72, float(entry["height_in"]) * 72
        elif "width_mm" in entry:
            w, h = float(entry["width_mm"]) * 72 / 25.4, float(entry["height_mm"]) * 72 / 25.4
        else:
            continue
        if width_limits and not width_limits[0] <= w <= width_limits[1]:
            raise SettingsError(
                f"Paper size {entry['id']}: the printer can't take paper {w / 72:g} inches wide "
                f"(limit {width_limits[1] / 72:.1f}). Swap width_in and height_in."
            )
        if height_limits and not height_limits[0] <= h <= height_limits[1]:
            raise SettingsError(f"Paper size {entry['id']}: {h / 72:g} inches long is outside what the printer takes.")
        table[str(entry["id"])] = Paper(w, h, f"Custom.{round(w, 2):g}x{round(h, 2):g}")
    return table


@dataclass
class JobSettings:
    PageSize: str = "auto"
    InputSlot: str = "Auto"
    MediaType: str = "Auto"
    ColorModel: str = "CMYK"
    Duplex: str = "None"
    RIPaperPolicy: str = "PromptUser"
    scaling: str = "fit"
    copies: int = 1
    page_ranges: str = ""
    pin: str = ""
    # Bypass jobs only: None = follow the config, True = wait for "Print now",
    # False = send straight away (paper's already loaded).
    hold: bool | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    def public_dict(self) -> dict:
        """Settings safe to show in the job list (never the PIN)."""
        data = self.to_dict()
        data["pin"] = bool(self.pin)
        return data


def resolve(cfg: Config, ppd: PPDInfo, *layers: dict | None) -> JobSettings:
    """Merge job_defaults, then each layer in order (preset, then the person's
    own picks), and validate the result against the PPD."""
    merged: dict = {}
    for layer in (cfg.job_defaults, *layers):
        for key, value in (layer or {}).items():
            if value is None or value == "":
                continue
            merged[key] = value

    s = JobSettings()
    page_size = str(merged.get("PageSize", s.PageSize))
    if page_size != "auto" and page_size not in paper_table(cfg, ppd):
        raise SettingsError(f"The printer doesn't know the paper size “{page_size}”.")
    s.PageSize = page_size

    for key in PPD_KEYS:
        value = str(merged.get(key, getattr(s, key)))
        if not ppd.has_choice(key, value):
            raise SettingsError(f"“{value}” isn't a valid choice for {_FRIENDLY.get(key, key)}.")
        setattr(s, key, value)

    scaling = str(merged.get("scaling", s.scaling))
    if scaling not in ("fit", "none"):
        raise SettingsError("Scaling must be “fit” or “none”.")
    s.scaling = scaling

    try:
        copies = int(merged.get("copies", 1))
    except (TypeError, ValueError):
        raise SettingsError("Copies must be a number.") from None
    if not 1 <= copies <= 999:
        raise SettingsError("Copies must be between 1 and 999.")
    s.copies = copies

    ranges = re.sub(r"\s+", "", str(merged.get("page_ranges", "")))
    if ranges.lower() in ("", "all"):
        ranges = ""
    elif not _PAGE_RANGES.match(ranges):
        raise SettingsError("Pages should look like 1-3, 5, 8-10.")
    else:
        for part in ranges.split(","):
            bounds = [int(n) for n in part.split("-")]
            if bounds[0] < 1 or bounds[-1] < bounds[0]:
                raise SettingsError(f"“{part}” isn't a valid page range.")
    s.page_ranges = ranges

    pin = str(merged.get("pin", "")).strip()
    if pin and not _PIN.match(pin):
        raise SettingsError("The PIN must be 4 to 8 digits.")
    s.pin = pin

    hold = merged.get("hold")
    if isinstance(hold, str):
        hold = {"true": True, "1": True, "yes": True, "false": False, "0": False, "no": False}.get(hold.lower())
    s.hold = hold if isinstance(hold, bool) else None
    return s


def ricoh_user_id(name: str | None) -> str | None:
    """The Ricoh job list shows a User ID of up to 8 plain characters."""
    if not name:
        return None
    cleaned = _RICOH_USER_ID_CHARS.sub("", name.strip().replace(" ", ""))[:8]
    return cleaned or None


def cups_options(s: JobSettings, paper: Paper, cfg: Config, user_name: str | None) -> dict[str, str]:
    """CUPS/PPD options for one job, for the resolved paper size."""
    opts: dict[str, str] = {
        "PageSize": paper.cups_value,
        "InputSlot": s.InputSlot,
        "MediaType": s.MediaType,
        "ColorModel": s.ColorModel,
        "Duplex": s.Duplex,
        "RIPaperPolicy": s.RIPaperPolicy,
        "print-scaling": s.scaling,
        "copies": str(s.copies),
    }
    if s.copies > 1:
        opts["Collate"] = "True"
        opts["collate"] = "true"
    if s.page_ranges:
        opts["page-ranges"] = s.page_ranges
    opts["UserId"] = ricoh_user_id(user_name) or "guest"
    if cfg.user_code:
        opts["UserCode"] = cfg.user_code
    if s.pin:
        opts["JobType"] = "LockedPrint"
        opts["LockedPrintPassword"] = s.pin
    return opts


def describe(s: JobSettings, page_size: str | None, cfg: Config) -> str:
    """Short human summary, e.g. "11 × 17 · Bypass tray · Thick 2 · B&W · 2 copies"."""
    sizes = {p["id"]: p.get("label", p["id"]) for p in cfg.page_sizes}
    trays = {t["id"]: t.get("label", t["id"]) for t in cfg.trays}
    media = {m["id"]: m.get("label", m["id"]) for m in cfg.media_types}
    size = page_size or s.PageSize
    parts = [sizes.get(size, "Match file" if size == "auto" else size).split(" (")[0]]
    if s.InputSlot != "Auto":
        parts.append(trays.get(s.InputSlot, s.InputSlot))
    if s.MediaType != "Auto":
        parts.append(media.get(s.MediaType, s.MediaType).split(" (")[0])
    parts.append("B&W" if s.ColorModel == "Gray" else "Color")
    if s.Duplex != "None":
        parts.append("2-sided")
    if s.copies > 1:
        parts.append(f"{s.copies} copies")
    if s.page_ranges:
        parts.append(f"pages {s.page_ranges}")
    if s.scaling == "none":
        parts.append("actual size")
    if s.pin:
        parts.append("held for PIN")
    return " · ".join(parts)
