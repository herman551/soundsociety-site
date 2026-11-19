"""A stand-in printer for tests: accepts jobs over raw socket (like port
9100) and/or LPD (RFC 1179) and saves each one to a folder.

    python3 tests/fake_printer.py --out /tmp/jobs --raw 9101 --lpd 5515
"""

from __future__ import annotations

import argparse
import socketserver
import threading
import time
from pathlib import Path

OUT = Path("/tmp/fake-printer")
_counter = 0
_lock = threading.Lock()


def _next_path(kind: str) -> Path:
    global _counter
    with _lock:
        _counter += 1
        n = _counter
    OUT.mkdir(parents=True, exist_ok=True)
    return OUT / f"{int(time.time() * 1000)}-{n:04d}-{kind}"


class RawHandler(socketserver.StreamRequestHandler):
    def handle(self):
        data = bytearray()
        while chunk := self.rfile.read(65536):
            data.extend(chunk)
        if data:
            path = _next_path("raw")
            path.with_suffix(".prn").write_bytes(data)


class LPDHandler(socketserver.StreamRequestHandler):
    """Just enough of RFC 1179 for CUPS' lpd backend."""

    def ack(self):
        self.wfile.write(b"\x00")
        self.wfile.flush()

    def handle(self):
        command = self.rfile.readline()
        if not command or command[0] != 2:  # 02 = receive a printer job
            self.ack()
            return
        queue = command[1:].strip().decode("latin-1")
        self.ack()
        base = _next_path("lpd")
        while True:
            sub = self.rfile.readline()
            if not sub:
                break
            code = sub[0]
            if code not in (2, 3):  # 02 control file, 03 data file
                self.ack()
                continue
            size_text, name = sub[1:].strip().split(b" ", 1)
            self.ack()
            payload = self.rfile.read(int(size_text))
            self.rfile.read(1)  # trailing NUL
            suffix = ".control" if code == 2 else ".prn"
            base.with_suffix(suffix).write_bytes(payload)
            self.ack()
        base.with_suffix(".queue").write_text(queue)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--raw", type=int, default=0)
    ap.add_argument("--lpd", type=int, default=0)
    args = ap.parse_args()
    OUT = Path(args.out)
    servers = []
    if args.raw:
        servers.append(Server(("127.0.0.1", args.raw), RawHandler))
    if args.lpd:
        servers.append(Server(("127.0.0.1", args.lpd), LPDHandler))
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"fake printer: raw={args.raw} lpd={args.lpd} -> {OUT}", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
