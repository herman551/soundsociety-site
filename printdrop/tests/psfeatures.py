"""Pull the driver settings back out of a PostScript job, so tests can check
what the Ricoh would actually be told."""

from __future__ import annotations

import re
from pathlib import Path

_FEATURE = re.compile(rb"%%BeginFeature: \*(\w+) ([^\r\n]+)")
_NONPPD = re.compile(rb"%RBIBeginNonPPDFeature: \*(\w+) ([^\r\n]+)")


def features(path: Path | str) -> dict[str, str]:
    data = Path(path).read_bytes()
    found: dict[str, str] = {}
    for rx in (_FEATURE, _NONPPD):
        for key, value in rx.findall(data):
            found[key.decode()] = value.decode("latin-1").strip()
    # On the bypass tray the Ricoh driver sends PageRegion instead of PageSize
    # (RequiresPageRegion MultiTray: True); for checking, they mean the same.
    if "PageSize" not in found and "PageRegion" in found:
        found["PageSize"] = found["PageRegion"]
    m = re.search(rb"%%BeginFeature: \*CustomPageSize True\s+([\d.]+)\s+([\d.]+)", data)
    if m:
        found["CustomSize"] = f"{float(m.group(1)):g}x{float(m.group(2)):g}"
    m = re.search(rb"%%Title: \(([^)]*)\)", data)
    if m:
        found["Title"] = m.group(1).decode("latin-1")
    m = re.search(rb"/usrid\(([^)]*)\)def", data)
    if m:
        found["usrid"] = m.group(1).decode("latin-1")
    m = re.search(rb"/lppswd\(([^)]*)\)def", data)
    if m:
        found["lppswd"] = m.group(1).decode("latin-1")
    return found


if __name__ == "__main__":
    import sys

    for arg in sys.argv[1:]:
        print(arg, features(arg))
