"""python -m printdrop            run the web server
python -m printdrop setup      create/update the CUPS queue (needs root)
python -m printdrop probe HOST check which print protocols a printer answers on"""

from __future__ import annotations

import logging
import sys


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    command = argv[1] if len(argv) > 1 else "serve"

    if command == "probe":
        from .printer import port_open

        if len(argv) < 3:
            print("usage: python -m printdrop probe PRINTER_IP")
            return 2
        host = argv[2]
        for port, name in ((9100, "raw (socket)"), (515, "LPD"), (631, "IPP"), (80, "web page")):
            print(f"  {name:13} port {port:<5} {'open' if port_open(host, port) else 'closed / unreachable'}")
        from .printer import detect_uri

        uri = detect_uri(host)
        print(f"\nPrintDrop would use: {uri}" if uri else "\nNo print port answered. Is this machine on the printer's network?")
        return 0 if uri else 1

    from .config import load_config

    cfg = load_config()

    if command == "setup":
        from .printer import resolve_uri, setup_queue

        uri = resolve_uri(cfg)
        if not uri:
            print("Set PRINTER (the printer's IP address) first.", file=sys.stderr)
            return 2
        setup_queue(cfg, uri)
        return 0

    if command == "serve":
        import uvicorn

        from .app import create_app

        uvicorn.run(create_app(cfg), host="0.0.0.0", port=cfg.port, proxy_headers=True, log_level="info")
        return 0

    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
