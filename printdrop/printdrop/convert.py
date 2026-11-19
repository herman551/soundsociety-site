"""Gets whatever someone dropped into a form the printer pipeline handles
well (PDF where possible), and measures it."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

PDF_EXT = {".pdf"}
PS_EXT = {".ps"}
TEXT_EXT = {".txt", ".text", ".log", ".md", ".csv"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff", ".bmp", ".webp", ".heic", ".heif"}
OFFICE_EXT = {
    ".doc", ".docx", ".odt", ".rtf", ".wpd",
    ".xls", ".xlsx", ".ods",
    ".ppt", ".pptx", ".odp", ".pps", ".ppsx",
}

OFFICE_TIMEOUT = 180


class ConvertError(Exception):
    """The file can't be printed. The message is shown to the person."""


@dataclass
class Prepared:
    path: Path
    pages: int | None = None
    size_pts: tuple[float, float] | None = None


def office_available() -> bool:
    return bool(shutil.which("soffice") or shutil.which("libreoffice"))


def _heif_available() -> bool:
    try:
        import pillow_heif  # noqa: F401
    except ImportError:
        return False
    return True


def supported_extensions() -> list[str]:
    exts = PDF_EXT | PS_EXT | TEXT_EXT | (IMAGE_EXT - {".heic", ".heif"})
    if _heif_available():
        exts |= {".heic", ".heif"}
    if office_available():
        exts |= OFFICE_EXT
    return sorted(exts)


def _sniff(path: Path) -> str | None:
    with open(path, "rb") as fh:
        head = fh.read(2048)
    if b"%PDF-" in head[:1024]:
        return "pdf"
    if head.startswith(b"%!PS"):
        return "ps"
    if head.startswith((b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"II*\x00", b"MM\x00*", b"BM")) or head[8:12] == b"WEBP":
        return "image"
    return None


def pdf_info(path: Path) -> tuple[int | None, tuple[float, float] | None]:
    try:
        out = subprocess.run(
            ["pdfinfo", str(path)], capture_output=True, text=True, timeout=60, check=False
        )
    except FileNotFoundError:
        return None, None
    if out.returncode != 0:
        message = (out.stderr or "").lower()
        if "incorrect password" in message or "encrypted" in message:
            raise ConvertError("This PDF is password-protected. Open it, save a copy without a password, and try again.")
        raise ConvertError("This PDF looks damaged and can't be read.")
    pages = None
    size = None
    rotated = False
    for line in out.stdout.splitlines():
        if line.startswith("Pages:"):
            try:
                pages = int(line.split(":", 1)[1])
            except ValueError:
                pass
        elif line.startswith("Page size:"):
            m = re.search(r"([\d.]+)\s*x\s*([\d.]+)\s*pts", line)
            if m:
                size = (float(m.group(1)), float(m.group(2)))
        elif line.startswith("Page rot:"):
            rotated = line.split(":", 1)[1].strip() in ("90", "270")
    if size and rotated:
        size = (size[1], size[0])
    return pages, size


def match_page_size(size_pts: tuple[float, float] | None, candidates: dict[str, tuple[float, float]],
                    tolerance: float = 12.0) -> str | None:
    """Find a known paper size within ``tolerance`` points, either orientation."""
    if not size_pts:
        return None
    w, h = sorted(size_pts)
    best: tuple[float, str] | None = None
    for name, dims in candidates.items():
        cw, ch = sorted(dims)
        error = abs(cw - w) + abs(ch - h)
        if abs(cw - w) <= tolerance and abs(ch - h) <= tolerance and (best is None or error < best[0]):
            best = (error, name)
    return best[1] if best else None


def _image_to_pdf(src: Path, dest: Path) -> None:
    try:
        from PIL import Image, ImageOps, ImageSequence
    except ImportError:
        raise ConvertError("Image printing isn't set up on this server.") from None
    if src.suffix.lower() in (".heic", ".heif"):
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except ImportError:
            raise ConvertError("iPhone HEIC photos aren't supported here. Export it as JPEG and try again.") from None
    try:
        with Image.open(src) as img:
            frames = []
            for frame in ImageSequence.Iterator(img):
                frame = ImageOps.exif_transpose(frame.copy())
                if frame.mode in ("RGBA", "LA", "P"):
                    frame = frame.convert("RGBA")
                    background = Image.new("RGB", frame.size, "white")
                    background.paste(frame, mask=frame.split()[-1])
                    frame = background
                elif frame.mode != "RGB":
                    frame = frame.convert("RGB")
                frames.append(frame)
                if len(frames) >= 200:
                    break
            if not frames:
                raise ConvertError("This image is empty.")
            frames[0].save(dest, "PDF", resolution=300.0, save_all=True, append_images=frames[1:])
    except ConvertError:
        raise
    except Exception as exc:  # Pillow raises many types for bad files
        raise ConvertError("This image couldn't be opened. It may be damaged or an unusual format.") from exc


def _office_to_pdf(src: Path, workdir: Path) -> Path:
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        raise ConvertError(
            "Word, Excel and PowerPoint files aren't supported on this server. Save as PDF and try again."
        )
    profile = workdir / "lo-profile"
    outdir = workdir / "converted"
    outdir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(workdir))
    try:
        result = subprocess.run(
            [binary, f"-env:UserInstallation=file://{profile}", "--headless", "--norestore",
             "--nolockcheck", "--convert-to", "pdf", "--outdir", str(outdir), str(src)],
            capture_output=True, text=True, timeout=OFFICE_TIMEOUT, env=env, check=False,
        )
    except subprocess.TimeoutExpired:
        raise ConvertError("Converting this document took too long. Save it as PDF and try again.") from None
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    produced = outdir / (src.stem + ".pdf")
    if result.returncode != 0 or not produced.exists():
        raise ConvertError("This document couldn't be converted for printing. Save it as PDF and try again.")
    return produced


def prepare(src: Path, workdir: Path) -> Prepared:
    """Return a printable file for ``src``. Never modifies ``src``."""
    if src.stat().st_size == 0:
        raise ConvertError("This file is empty.")
    ext = src.suffix.lower()
    kind = _sniff(src)

    if kind == "pdf" or (kind is None and ext in PDF_EXT):
        pages, size = pdf_info(src)
        return Prepared(src, pages, size)
    if kind == "ps" or ext in PS_EXT:
        return Prepared(src)
    if kind == "image" or ext in IMAGE_EXT:
        dest = workdir / (src.stem + ".pdf")
        _image_to_pdf(src, dest)
        pages, size = pdf_info(dest)
        return Prepared(dest, pages, size)
    if ext in OFFICE_EXT:
        pdf = _office_to_pdf(src, workdir)
        pages, size = pdf_info(pdf)
        return Prepared(pdf, pages, size)
    if ext in TEXT_EXT:
        return Prepared(src)
    if ext in (".pages", ".numbers", ".key"):
        raise ConvertError("Apple Pages/Numbers/Keynote files can't be printed directly. Export as PDF and try again.")
    raise ConvertError(
        f"PrintDrop can't print {ext or 'this kind of'} files. PDF always works."
    )
