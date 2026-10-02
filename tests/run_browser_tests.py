"""Headless browser tests for HoMo CFD.

    py tests/run_browser_tests.py            (from the project folder)

Builds a synthetic results folder (tests/fixture.py) in a temporary folder,
serves the app with the real serve.py handler plus a few test-only routes,
and drives headless Chrome or Edge through three test pages:

  first-start.html  no working directory yet: choose one, results load
  server-mode.html  working directory set: tree, viewers, pressure, 3D, Stage 5
  picker-mode.html  page opened without serve.py: browser folder picker
                    (mocked handles), regressions from the 2026-10-02 review

Uses a temporary APPDATA, so real HoMo CFD / CFD-Tool settings are untouched.
Set HOMO_TEST_BROWSER to a Chrome/Edge executable to choose the browser.
Exit code 0 when every check passes.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
BROWSER_DIR = HERE / "browser"
TIMEOUT_SECONDS = 240

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(PROJECT))
import fixture  # noqa: E402
from test_cluster import FakeWinScp  # noqa: E402


def load_serve():
    spec = importlib.util.spec_from_file_location("serve", PROJECT / "serve.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def find_browser():
    candidates = [os.environ.get("HOMO_TEST_BROWSER")]
    for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
        if base:
            candidates += [
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
            ]
    candidates += [shutil.which(name) for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")]
    return next((path for path in candidates if path and os.path.isfile(path)), None)


def make_handler(serve, working_dir):
    finished = working_dir / "finished"
    # Virtual folders for picker-mode (mocked browser handles):
    # dict = virtual folder, (path, options) = real folder.
    scenarios = {
        "single": (finished / "caseA", {}),
        "multi": {
            "caseA": (finished / "caseA", {}),
            "caseB": (finished / "caseB", {}),
            "caseC": (finished / "caseA", {"fail": {"plots/Coefficients_49.csv"}}),
            ".git": {"objects": {}},
        },
        "nested": {"finished": {"caseA": (finished / "caseA", {}), "caseB": (finished / "caseB", {})}},
    }
    injected = {
        "/__app_test.html": ("index.html", "./app.js"),
        "/__viewer_test.html": ("image-viewer.html", "./image-viewer.js"),
        "/__3d_test.html": ("3d-viewer.html", "./3d-viewer.js"),
    }

    def resolve(parts):
        node, rest = scenarios, []
        for part in parts:
            if isinstance(node, dict):
                if part not in node:
                    return None, None, None
                node = node[part]
            else:
                rest.append(part)
        if isinstance(node, tuple):
            base, options = node
            return base.joinpath(*rest), "/".join(rest), options
        return node, None, None

    class TestHandler(serve.Handler):
        # Never the user's real WinSCP sessions or Fritz.
        winscp = FakeWinScp(0, "Session started.\n/home/vault/g/u/Pipeline\n", sessions=["Fritz", "Other"])
        results = []
        result_ready = threading.Event()

        def log_message(self, *args):
            pass

        def send_bytes(self, data, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            referer = urlsplit(self.headers.get("Referer") or "").path
            if path == "/api/config" and referer in injected:
                # Injected test pages act as if opened without serve.py.
                return self.send_bytes(b"not served by serve.py", "text/plain", 404)
            if path in injected:
                source, script = injected[path]
                html = (serve.WEB / source).read_text(encoding="utf-8")
                html = html.replace(f'<script src="{script}"></script>',
                                    f'<script src="/test/mock.js"></script><script src="{script}"></script>')
                return self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
            if path.startswith("/test/"):
                target = BROWSER_DIR / path[len("/test/"):]
                if target.is_file() and BROWSER_DIR in target.resolve().parents:
                    kind = "text/javascript" if target.suffix == ".js" else "text/html; charset=utf-8"
                    return self.send_bytes(target.read_bytes(), kind)
                return self.send_bytes(b"missing", "text/plain", 404)
            if path.startswith("/mock-list/") or path.startswith("/mock-file/"):
                kind, rest = path[1:].split("/", 1)
                node, relative, options = resolve([part for part in rest.split("/") if part])
                if node is None:
                    return self.send_bytes(b"missing", "text/plain", 404)
                if kind == "mock-list":
                    if isinstance(node, dict):
                        entries = [{"name": name, "kind": "directory"} for name in node]
                    else:
                        entries = [{"name": child.name, "kind": "directory" if child.is_dir() else "file"}
                                   for child in sorted(node.iterdir(), key=lambda item: item.name)]
                    return self.send_bytes(json.dumps(entries).encode("utf-8"), "application/json")
                if relative in options.get("fail", ()):
                    return self.send_bytes(b"fail", "text/plain", 500)
                return self.send_bytes(Path(node).read_bytes(), "application/octet-stream")
            return super().do_GET()

        def do_POST(self):
            if self.path != "/result":
                return super().do_POST()
            body = self.rfile.read(int(self.headers["Content-Length"]))
            type(self).results = json.loads(body)
            self.send_bytes(b"ok", "text/plain")
            type(self).result_ready.set()

    return TestHandler


def run_page(browser, handler, url, profile):
    handler.result_ready.clear()
    handler.results = []
    process = subprocess.Popen(
        [browser, "--headless=new", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
         "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1500,1000", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        finished = handler.result_ready.wait(TIMEOUT_SECONDS)
    finally:
        process.kill()
        process.wait(timeout=30)
        time.sleep(1)  # let helper processes release the profile
    if not finished:
        return [{"name": f"{url}: finished within {TIMEOUT_SECONDS} s", "pass": False, "detail": "timed out"}]
    return handler.results


def main():
    browser = find_browser()
    if not browser:
        print("No Chrome or Edge found. Set HOMO_TEST_BROWSER to its executable.")
        return 2
    temp = Path(tempfile.mkdtemp(prefix="homo-cfd-tests-"))
    os.environ["APPDATA"] = str(temp / "appdata")  # isolate HoMo/CFD-Tool settings
    serve = load_serve()
    working_dir = fixture.build(temp)
    handler = make_handler(serve, working_dir)
    server = serve.Server(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"Fixture: {working_dir}\nBrowser: {browser}\n")

    pages = [
        ("first-start", lambda: handler.working_dir.set(None, None), f"/test/first-start.html?dir={working_dir}"),
        ("server-mode", lambda: handler.working_dir.set(working_dir, "test"), "/test/server-mode.html"),
        ("picker-mode", lambda: None, "/test/picker-mode.html"),
    ]
    failures = 0
    total = 0
    try:
        for index, (name, prepare, page) in enumerate(pages):
            prepare()
            results = run_page(browser, handler, base + page, temp / f"profile-{index}")
            print(f"== {name}")
            for result in results:
                total += 1
                failures += not result["pass"]
                detail = f"  [{result['detail'][:400]}]" if not result["pass"] and result.get("detail") else ""
                print(f"{'PASS' if result['pass'] else 'FAIL'} {result['name']}{detail}")
            print()
    finally:
        server.shutdown()
        shutil.rmtree(temp, ignore_errors=True)
    print(f"{total - failures} / {total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
