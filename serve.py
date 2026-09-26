"""Serve HoMo CFD locally. Python 3 stdlib only."""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "web"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 5173), Handler)
    print("HoMo CFD  http://127.0.0.1:5173")
    print("Stop with Ctrl+C")
    server.serve_forever()


if __name__ == "__main__":
    main()
