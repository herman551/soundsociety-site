"""Reads the printer's PPD so PrintDrop only ever sends options the Ricoh
driver actually understands."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

_OPEN_UI = re.compile(r"^\*OpenUI\s+\*(?P<key>[^/:\s]+)(?:/(?P<text>[^:]*))?:")
_CLOSE_UI = re.compile(r"^\*CloseUI:?\s+\*(?P<key>[^\s]+)")
_CHOICE = re.compile(r"^\*(?P<key>[^\s/:]+)\s+(?P<choice>[^/:\s]+)(?:/(?P<text>[^:]*))?:")
_PAPER = re.compile(r'^\*PaperDimension\s+(?P<name>[^/:\s]+)(?:/[^:]*)?:\s*"(?P<w>[\d.]+)\s+(?P<h>[\d.]+)"')
_CUSTOM = re.compile(r"^\*ParamCustomPageSize\s+(?P<dim>Width|Height):\s*\d+\s+points\s+(?P<min>[\d.]+)\s+(?P<max>[\d.]+)")


@dataclass
class PPDInfo:
    path: Path
    model: str = ""
    options: dict[str, dict[str, str]] = field(default_factory=dict)  # option -> {choice: label}
    option_labels: dict[str, str] = field(default_factory=dict)
    paper: dict[str, tuple[float, float]] = field(default_factory=dict)  # PageSize -> (w, h) points
    custom_limits: dict[str, tuple[float, float]] = field(default_factory=dict)  # Width/Height -> (min, max)

    def choices(self, option: str) -> dict[str, str]:
        return self.options.get(option, {})

    def has_choice(self, option: str, choice: str) -> bool:
        return choice in self.options.get(option, {})


def parse_ppd(path: Path | str) -> PPDInfo:
    path = Path(path)
    info = PPDInfo(path=path)
    current: str | None = None
    with open(path, encoding="latin-1") as fh:
        for line in fh:
            if line.startswith("*ModelName:"):
                info.model = line.split(":", 1)[1].strip().strip('"')
                continue
            m = _OPEN_UI.match(line)
            if m:
                current = m.group("key")
                info.options.setdefault(current, {})
                info.option_labels[current] = (m.group("text") or current).strip()
                continue
            if _CLOSE_UI.match(line):
                current = None
                continue
            m = _CUSTOM.match(line)
            if m:
                info.custom_limits[m.group("dim")] = (float(m.group("min")), float(m.group("max")))
                continue
            m = _PAPER.match(line)
            if m:
                info.paper[m.group("name")] = (float(m.group("w")), float(m.group("h")))
                continue
            if current:
                m = _CHOICE.match(line)
                if m and m.group("key") == current:
                    info.options[current][m.group("choice")] = (m.group("text") or m.group("choice")).strip()
    return info


@lru_cache(maxsize=4)
def load_ppd(path: str) -> PPDInfo:
    return parse_ppd(path)
