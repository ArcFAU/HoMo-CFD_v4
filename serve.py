"""Serve HoMo CFD locally. Python 3 stdlib only; works offline.

Usage:
    py serve.py                                # use the saved working directory
    py serve.py --open                         # ...and open the app in the browser
    py serve.py --working-dir "D:\\CFD_tool"   # use this working directory for this run

Like CFD-Tool, HoMo CFD keeps one per-user setting, the *working directory*
(the folder holding finished/, inProgress/, archive/, ...). It is stored in
%APPDATA%\\HoMo-CFD\\settings.json, outside the app folder, so every person
can keep their results anywhere and app updates never lose the setting.

Where the working directory comes from, first match wins:
  1. --working-dir on the command line (this run only)
  2. HoMo CFD's saved setting
  3. CFD-Tool's saved working directory (%APPDATA%\\CFD-Tool\\resources\\workingDir)
  4. otherwise the app asks for it on first start ("Choose working directory")

Results are read from <working dir>\\finished when that folder exists,
otherwise from the working directory itself.

Fritz cluster access (Stage 7) goes through the user's WinSCP saved session;
see cluster.py. It runs only when the user clicks a button in the app.
"""

import argparse
import email.utils
import json
import mimetypes
import os
import shutil
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import cluster

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"


def user_config_dir():
    """Per-user settings folder: %APPDATA%\\HoMo-CFD on Windows."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "HoMo-CFD"
    return Path.home() / ".config" / "homo-cfd"


def settings_file():
    return user_config_dir() / "settings.json"


def read_settings():
    try:
        return json.loads(settings_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_settings(settings):
    path = settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def cfd_tool_working_dir():
    """The working directory saved by the legacy CFD-Tool, if any."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    try:
        lines = (Path(appdata) / "CFD-Tool" / "resources" / "workingDir").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    return lines[0].strip() if lines and lines[0].strip() else None


def results_folder(working_dir):
    """CFD-Tool layout keeps results in <working dir>\\finished."""
    finished = working_dir / "finished"
    return finished if finished.is_dir() else working_dir


class WorkingDirectory:
    """The current working directory and where it came from (thread-safe)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.path = None
        self.source = None

    def set(self, path, source):
        with self.lock:
            self.path, self.source = path, source

    def results_root(self):
        with self.lock:
            return results_folder(self.path) if self.path else None

    def describe(self):
        with self.lock:
            path, source = self.path, self.source
        root = results_folder(path) if path else None
        return {
            "workingDir": str(path) if path else None,
            "source": source,
            "resultsRoot": root.name if root else None,
            "resultsPath": str(root) if root else None,
            "canBrowse": tkinter_available(),
        }


def find_working_dir(cli_value):
    """Apply the precedence documented at the top of this file."""
    candidates = [
        (cli_value, "command line"),
        (read_settings().get("workingDir"), "HoMo CFD settings"),
        (cfd_tool_working_dir(), "CFD-Tool"),
    ]
    for value, source in candidates:
        if value and Path(value).expanduser().is_dir():
            return Path(value).expanduser().absolute(), source
        if value and source == "command line":
            raise SystemExit(f"Working directory not found: {value}")
    return None, None


def tkinter_available():
    try:
        import tkinter  # noqa: F401
        return True
    except ImportError:
        return False


def browse_for_folder(initial):
    """Native folder dialog on this computer (the server runs locally)."""
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)  # don't open behind the browser
    try:
        chosen = filedialog.askdirectory(
            parent=root,
            title="Choose Working Directory",
            initialdir=initial or str(Path.home()),
            mustexist=True,
        )
    finally:
        root.destroy()
    return chosen or None


def visible(entry):
    # Hidden folders/files (.git, .vscode, ...) never hold results.
    return not entry.name.startswith(".")


def list_folder(directory):
    """Visible (name, is_folder) pairs of one folder, sorted by name.

    os.scandir reuses the file type from the directory listing, which keeps
    indexing hundreds of result folders fast on Windows.
    """
    entries = []
    with os.scandir(directory) as scan:
        for entry in scan:
            if not visible(entry):
                continue
            try:
                if entry.is_dir():
                    entries.append((entry.name, True))
                elif entry.is_file():
                    entries.append((entry.name, False))
            except OSError:
                continue
    return sorted(entries)


def scan_tree(directory):
    """Nested listing {"d": {name: subtree}, "f": [file names]} of a folder."""
    folders, files = {}, []
    try:
        entries = list_folder(directory)
    except OSError:
        return {"d": folders, "f": files}
    for name, is_folder in entries:
        if is_folder:
            folders[name] = scan_tree(os.path.join(directory, name))
        else:
            files.append(name)
    return {"d": folders, "f": files}


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server bind a port that is
    # already in use; without it, a second start fails cleanly instead.
    allow_reuse_address = os.name != "nt"
    # The app requests many small files at once (e.g. pressure stations);
    # the default backlog of 5 makes Windows refuse some of them.
    request_queue_size = 128


class Handler(SimpleHTTPRequestHandler):
    working_dir = WorkingDirectory()
    browse_lock = threading.Lock()
    winscp = cluster.WinScp()
    cluster_lock = threading.Lock()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        # The app is local and changes often; always revalidate.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def local_request(self):
        """Only answer API calls addressed to this computer's own server.

        Blocks other web pages (DNS rebinding) from reading results or
        changing settings through the user's browser.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host in ("127.0.0.1", "localhost", "::1"):
            return True
        self.send_json({"error": "Forbidden host."}, HTTPStatus.FORBIDDEN)
        return False

    def do_GET(self):
        url = urlsplit(self.path)
        routes = {
            "/api/config": self.api_config,
            "/api/tree": self.api_tree,
            "/api/list": self.api_list,
            "/api/file": self.api_file,
            "/api/cluster": self.api_cluster,
        }
        route = routes.get(url.path)
        if route is None:
            return super().do_GET()
        if not self.local_request():
            return
        query = parse_qs(url.query)
        route((query.get("path") or [""])[0])

    def do_HEAD(self):
        if urlsplit(self.path).path.startswith("/api/"):
            return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        return super().do_HEAD()

    def do_POST(self):
        routes = {
            "/api/working-dir": self.api_set_working_dir,
            "/api/working-dir/browse": self.api_browse_working_dir,
            "/api/cluster": self.api_save_cluster,
            "/api/cluster/test": self.api_test_cluster,
        }
        route = routes.get(urlsplit(self.path).path)
        if route is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        if not self.local_request():
            return
        # A JSON body forces a CORS preflight, which this server never
        # approves, so other sites cannot trigger these actions.
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send_json({"error": "Expected JSON."}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length <= 65536 else None
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.send_json({"error": "Invalid request."}, HTTPStatus.BAD_REQUEST)
        route(body)

    # --- working directory ---------------------------------------------

    def save_working_dir(self, value):
        path = Path(value.strip().strip('"')).expanduser() if value else None
        if not path or not path.is_absolute() or not path.is_dir():
            return self.send_json({"error": f"Folder not found: {value}"}, HTTPStatus.BAD_REQUEST)
        path = path.absolute()
        settings = read_settings()
        settings["workingDir"] = str(path)
        write_settings(settings)
        self.working_dir.set(path, "HoMo CFD settings")
        self.send_json(self.working_dir.describe())

    def api_set_working_dir(self, body):
        self.save_working_dir(body.get("path") if isinstance(body.get("path"), str) else None)

    def api_browse_working_dir(self, _body):
        if not tkinter_available():
            return self.send_json({"error": "Folder dialog unavailable; type the folder path instead."}, HTTPStatus.NOT_IMPLEMENTED)
        if not self.browse_lock.acquire(blocking=False):
            return self.send_json({"error": "A folder dialog is already open."}, HTTPStatus.CONFLICT)
        try:
            current = self.working_dir.describe()["workingDir"]
            chosen = browse_for_folder(current)
        finally:
            self.browse_lock.release()
        if not chosen:
            return self.send_json({"cancelled": True, **self.working_dir.describe()})
        self.save_working_dir(chosen)

    # --- Fritz cluster (WinSCP) ----------------------------------------

    def cluster_settings(self):
        saved = read_settings().get("cluster")
        saved = saved if isinstance(saved, dict) else {}
        return {"session": saved.get("session") or "", "remoteFolder": saved.get("remoteFolder") or ""}

    def api_cluster(self, _path):
        executable = self.winscp.executable()
        self.send_json({
            "winscp": str(executable) if executable else None,
            "sessions": self.winscp.sessions(),
            **self.cluster_settings(),
        })

    def checked_cluster_body(self, body):
        try:
            return cluster.check_session(body.get("session")), cluster.check_remote_folder(body.get("remoteFolder"))
        except ValueError as err:
            self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
            return None

    def api_save_cluster(self, body):
        checked = self.checked_cluster_body(body)
        if checked is None:
            return
        settings = read_settings()
        settings["cluster"] = {"session": checked[0], "remoteFolder": checked[1]}
        write_settings(settings)
        self.api_cluster("")

    def api_test_cluster(self, body):
        checked = self.checked_cluster_body(body)
        if checked is None:
            return
        if self.winscp.executable() is None:
            return self.send_json({"ok": False, "error": "WinSCP is not installed (WinSCP.com not found).",
                                   "hint": "Install WinSCP, as for CFD-Tool, then test again."})
        if not self.cluster_lock.acquire(blocking=False):
            return self.send_json({"error": "A connection test is already running."}, HTTPStatus.CONFLICT)
        try:
            result = cluster.test_connection(self.winscp, *checked)
        finally:
            self.cluster_lock.release()
        self.send_json(result)

    # --- results API ---------------------------------------------------

    def results_path(self, relative):
        """Map a "case/Cp_x-Section/001.png" path into the results folder.

        Rejects absolute paths, drive letters, "..", backslashes and hidden
        entries so nothing outside the results folder can be reached.
        """
        root = self.working_dir.results_root()
        if root is None:
            self.send_json({"error": "No working directory is set."}, HTTPStatus.NOT_FOUND)
            return None
        parts = [part for part in unquote(relative).split("/") if part]
        for part in parts:
            if part in (".", "..") or part.startswith(".") or "\\" in part or ":" in part:
                self.send_json({"error": "Invalid path."}, HTTPStatus.BAD_REQUEST)
                return None
        target = root.joinpath(*parts)
        if not target.exists():
            self.send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return None
        return target

    def send_json(self, value, status=HTTPStatus.OK):
        data = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def api_config(self, _path):
        self.send_json(self.working_dir.describe())

    def api_tree(self, relative):
        target = self.results_path(relative)
        if target is None:
            return
        if not target.is_dir():
            return self.send_json({"error": "Not a folder."}, HTTPStatus.BAD_REQUEST)
        self.send_json(scan_tree(target))

    def api_list(self, relative):
        target = self.results_path(relative)
        if target is None:
            return
        if not target.is_dir():
            return self.send_json({"error": "Not a folder."}, HTTPStatus.BAD_REQUEST)
        self.send_json([
            {"name": name, "kind": "directory" if is_folder else "file"}
            for name, is_folder in list_folder(target)
        ])

    def api_file(self, relative):
        target = self.results_path(relative)
        if target is None:
            return
        if not target.is_file():
            return self.send_json({"error": "Not a file."}, HTTPStatus.BAD_REQUEST)
        stat = target.stat()
        modified = email.utils.formatdate(stat.st_mtime, usegmt=True)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                if email.utils.parsedate_to_datetime(since).timestamp() >= int(stat.st_mtime):
                    self.send_response(HTTPStatus.NOT_MODIFIED)
                    self.end_headers()
                    return
            except (TypeError, ValueError):
                pass
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Last-Modified", modified)
        self.end_headers()
        with target.open("rb") as source:
            shutil.copyfileobj(source, self.wfile)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve HoMo CFD on http://127.0.0.1")
    parser.add_argument("--working-dir", help="working directory for this run (folder with finished/, or a results folder)")
    parser.add_argument("--results", dest="working_dir", help=argparse.SUPPRESS)  # older name
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--open", action="store_true", help="open the app in the default browser")
    args = parser.parse_args()

    path, source = find_working_dir(args.working_dir)
    Handler.working_dir.set(path, source)
    url = f"http://127.0.0.1:{args.port}"
    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError:
        # Most likely HoMo CFD is already running: just show it.
        print(f"Port {args.port} is in use; HoMo CFD is probably already running at {url}")
        if args.open:
            webbrowser.open(url)
        return
    print(f"HoMo CFD  {url}")
    if path:
        print(f"Working directory: {path} (from {source})")
        print(f"Results folder:    {results_folder(path)}")
    else:
        print("No working directory yet: choose one in the app.")
    print("Stop with Ctrl+C")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
