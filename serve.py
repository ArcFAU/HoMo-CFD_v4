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
import base64
import email.utils
import json
import mimetypes
import os
import atexit
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

# Python writes no __pycache__ into the app folder: teammates run HoMo CFD from a
# shared (SVN) folder, where such files would show up as changes.
sys.dont_write_bytecode = True
import cluster  # noqa: E402

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


class TreeCache:
    """The last scanned tree of the results folder, in memory and in the settings folder.

    Results often sit on a hard disk: once Windows has dropped the folder data from
    memory, scanning ~50,000 files there takes 7-15 s. The start page shows this copy
    at once and then asks for a fresh scan, which also updates the copy.
    """

    def __init__(self, file=None):
        self.file = file
        self.lock = threading.Lock()
        self.root = None
        self.tree = None

    def path(self):
        return self.file or user_config_dir() / "tree-cache.json"

    def get(self, root):
        with self.lock:
            if self.root == root:
                return self.tree
        try:
            saved = json.loads(self.path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not (isinstance(saved, dict) and saved.get("root") == root and isinstance(saved.get("tree"), dict)):
            return None
        with self.lock:
            self.root, self.tree = root, saved["tree"]
        return saved["tree"]

    def put(self, root, tree):
        with self.lock:
            self.root, self.tree = root, tree
        try:
            path = self.path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"root": root, "tree": tree}, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            pass  # the copy only saves time


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

    def cfd_folders(self):
        """(finished, inProgress) when the working directory has CFD-Tool's layout."""
        with self.lock:
            path = self.path
        if path and (path / "finished").is_dir():
            return path / "finished", path / "inProgress"
        return None

    def describe(self):
        with self.lock:
            path, source = self.path, self.source
        root = results_folder(path) if path else None
        return {
            "workingDir": str(path) if path else None,
            "source": source,
            "resultsRoot": root.name if root else None,
            "resultsPath": str(root) if root else None,
            "canBrowse": dialogs_available(),
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


def powershell():
    """Windows PowerShell, which opens the dialogs when Python has no tkinter
    (the portable build uses Python's embeddable package, without tkinter)."""
    if os.name != "nt":
        return None
    found = shutil.which("powershell.exe")
    if found:
        return found
    fallback = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    return str(fallback) if fallback.is_file() else None


def dialogs_available():
    return tkinter_available() or powershell() is not None


# The same Windows dialogs through PowerShell. Title and starting folder come in
# environment variables, so no path is ever pasted into the command.
DIALOG_SETUP = """
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$start = $env:HOMO_DIALOG_START
"""
FOLDER_DIALOG = DIALOG_SETUP + """
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:HOMO_DIALOG_TITLE
$dialog.ShowNewFolderButton = $false
if ($start -and (Test-Path -LiteralPath $start -PathType Container)) { $dialog.SelectedPath = $start }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
"""
SIM_DIALOG = DIALOG_SETUP + """
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:HOMO_DIALOG_TITLE
$dialog.Filter = 'STAR-CCM+ simulation (*.sim)|*.sim|All files (*.*)|*.*'
if ($start -and (Test-Path -LiteralPath $start -PathType Container)) { $dialog.InitialDirectory = $start }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
"""


def powershell_dialog(script, title, start):
    """Run a dialog script; returns the chosen path, or None when cancelled."""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    env = {**os.environ, "HOMO_DIALOG_TITLE": title, "HOMO_DIALOG_START": start or ""}
    completed = subprocess.run(
        [powershell(), "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
        capture_output=True, env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace").strip()[-300:] or "PowerShell failed.")
    return completed.stdout.decode("utf-8", errors="replace").strip() or None


def browse_for_folder(initial):
    """Native folder dialog on this computer (the server runs locally)."""
    if not tkinter_available():
        return powershell_dialog(FOLDER_DIALOG, "Choose Working Directory", initial)
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


def browse_for_sim(initial):
    """Native file dialog for the base .sim of a new simulation."""
    if not tkinter_available():
        return powershell_dialog(SIM_DIALOG, "Choose the base .sim file", initial)
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        chosen = filedialog.askopenfilename(
            parent=root,
            title="Choose the base .sim file",
            initialdir=initial or str(Path.home()),
            filetypes=[("STAR-CCM+ simulation", "*.sim"), ("All files", "*.*")],
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


# Without a console (--background), HoMo CFD stops by itself once no window has
# been open for this long (pages report every minute), unless a download or
# upload is still running.
IDLE_MINUTES = 30


def should_stop(last_seen, now, busy, idle_minutes=IDLE_MINUTES):
    return not busy and now - last_seen > idle_minutes * 60


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server bind a port that is
    # already in use; without it, a second start fails cleanly instead.
    allow_reuse_address = os.name != "nt"
    # The app requests many small files at once (e.g. pressure stations);
    # the default backlog of 5 makes Windows refuse some of them.
    request_queue_size = 128


class Handler(SimpleHTTPRequestHandler):
    working_dir = WorkingDirectory()
    tree_cache = TreeCache()
    browse_lock = threading.Lock()
    winscp = cluster.WinScp()
    cluster_lock = threading.Lock()
    status_lock = threading.Lock()
    download_lock = threading.Lock()
    downloads = {}          # case name → cluster.Download, for this server run
    creating = {}           # case name → cluster.Download used as a progress record
    submitted = {}          # case name → SLURM job id, for this server run
    remote_info = {}        # case name → case from the last status check
    remote_cases = set()    # case names from the last status check
    last_seen = time.monotonic()  # last request from an open HoMo CFD window

    @classmethod
    def busy(cls):
        """A WinSCP download or new-simulation upload is running."""
        return any(task.state == "running" for task in [*cls.downloads.values(), *cls.creating.values()])

    def stop_server(self):
        # shutdown() waits for serve_forever, so it must run in another thread.
        threading.Thread(target=self.server.shutdown, daemon=True).start()

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
            "/api/cluster/downloads": self.api_cluster_downloads,
            "/api/cluster/new-case": self.api_new_case_tasks,
            "/api/alive": self.api_alive,
        }
        route = routes.get(url.path)
        if route is None:
            return super().do_GET()
        if not self.local_request():
            return
        Handler.last_seen = time.monotonic()
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
            "/api/cluster/pageant": self.api_start_pageant,
            "/api/cluster/cases": self.api_cluster_cases,
            "/api/cluster/download": self.api_cluster_download,
            "/api/cluster/download/cancel": self.api_cluster_cancel,
            "/api/cluster/settings-file": self.api_settings_file,
            "/api/cluster/browse-sim": self.api_browse_sim,
            "/api/cluster/new-case": self.api_new_case,
            "/api/cluster/submit": self.api_submit,
            "/api/quit": self.api_quit,
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
        Handler.last_seen = time.monotonic()
        route(body)

    # --- running in the background ---------------------------------------

    def api_alive(self, _path):
        """Heartbeat from open windows (see IDLE_MINUTES)."""
        self.send_json({"ok": True})

    def api_quit(self, _body):
        if self.busy():
            return self.send_json({"error": "A download or upload to Fritz is still running. Wait for it or cancel it first."},
                                  HTTPStatus.CONFLICT)
        self.send_json({"ok": True})
        self.stop_server()

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
        if not dialogs_available():
            return self.send_json({"error": "Folder dialog unavailable; type the folder path instead."}, HTTPStatus.NOT_IMPLEMENTED)
        if not self.browse_lock.acquire(blocking=False):
            return self.send_json({"error": "A folder dialog is already open."}, HTTPStatus.CONFLICT)
        try:
            current = self.working_dir.describe()["workingDir"]
            chosen = browse_for_folder(current)
        except (OSError, RuntimeError):
            return self.send_json({"error": "The folder dialog could not open; type the folder path instead."}, HTTPStatus.NOT_IMPLEMENTED)
        finally:
            self.browse_lock.release()
        if not chosen:
            return self.send_json({"cancelled": True, **self.working_dir.describe()})
        self.save_working_dir(chosen)

    # --- Fritz cluster (WinSCP) ----------------------------------------

    def cluster_settings(self):
        saved = read_settings().get("cluster")
        saved = saved if isinstance(saved, dict) else {}
        return {"session": saved.get("session") or "", "remoteFolder": saved.get("remoteFolder") or "",
                "submitSession": saved.get("submitSession") or "",
                "templateFolder": saved.get("templateFolder") or cluster.DEFAULT_TEMPLATE}

    def api_cluster(self, _path):
        executable = self.winscp.executable()
        self.send_json({
            "winscp": str(executable) if executable else None,
            "sessions": self.winscp.sessions(),
            "sessionHosts": self.winscp.session_hosts(),
            "pageant": {"found": self.winscp.pageant() is not None, "running": self.winscp.pageant_running()},
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
        try:
            submit = cluster.check_session(body["submitSession"]) if body.get("submitSession") else ""
            template = cluster.check_case_name(body["templateFolder"]) if body.get("templateFolder") else cluster.DEFAULT_TEMPLATE
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        settings = read_settings()
        settings["cluster"] = {"session": checked[0], "remoteFolder": checked[1],
                               "submitSession": submit, "templateFolder": template}
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
            if result["ok"] and body.get("submitSession"):
                result["submit"] = self.test_submit_session(body["submitSession"], checked[1])
        finally:
            self.cluster_lock.release()
        self.send_json(result)

    def test_submit_session(self, session, remote_folder):
        """Read-only: can the job session use SLURM (sbatch --version)?"""
        try:
            session = cluster.check_session(session)
        except ValueError as err:
            return {"ok": False, "error": str(err)}
        code, output = self.winscp.run(cluster.submit_test_script(session, remote_folder))
        version = next((line.strip() for line in output.splitlines() if line.strip().startswith("slurm ")), "")
        if code == 0 and version:
            return {"ok": True, "version": version}
        return {"ok": False, "error": "This session cannot start jobs (no SLURM there).",
                "hint": cluster.hint_for(output), "output": output.strip()[-cluster.MAX_OUTPUT:]}

    def api_start_pageant(self, body):
        """Unlock the session's key in Pageant; Pageant asks for the passphrase."""
        try:
            session = cluster.check_session(body.get("session"))
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        if self.winscp.pageant() is None:
            return self.send_json({"error": "Pageant was not found. Install PuTTY (it includes Pageant)."}, HTTPStatus.NOT_FOUND)
        key_file = self.winscp.session_key_file(session)
        if key_file is None:
            return self.send_json({"error": "This WinSCP session has no private key file set (or the file was moved). "
                                            "Set it in WinSCP: Edit session → Advanced → SSH → Authentication."}, HTTPStatus.BAD_REQUEST)
        self.winscp.start_pageant(key_file)
        self.send_json({"started": True})

    # Step 2: what is on Fritz, and downloads into the working directory.

    def api_cluster_cases(self, _body):
        """Status of every case folder in the saved remote folder (read-only)."""
        saved = self.cluster_settings()
        if not saved["session"] or not saved["remoteFolder"]:
            return self.send_json({"error": "Save your WinSCP session and remote folder first."}, HTTPStatus.BAD_REQUEST)
        if self.winscp.executable() is None:
            return self.send_json({"error": "WinSCP is not installed (WinSCP.com not found)."}, HTTPStatus.BAD_REQUEST)
        if not self.status_lock.acquire(blocking=False):
            return self.send_json({"error": "A status check is already running."}, HTTPStatus.CONFLICT)
        try:
            jobs = {}
            if saved["submitSession"]:
                def read_jobs():
                    job_code, job_output = self.winscp.run(cluster.jobs_script(saved["submitSession"]))
                    jobs["result"] = cluster.parse_jobs(job_output) if job_code == 0 else None
                job_thread = threading.Thread(target=read_jobs, daemon=True)
                job_thread.start()
            code, output = self.winscp.run(cluster.status_script(saved["session"], saved["remoteFolder"]))
            if saved["submitSession"]:
                job_thread.join(cluster.TIMEOUT_SECONDS + 5)
        finally:
            self.status_lock.release()
        if code != 0:
            return self.send_json({"ok": False, "error": "Could not check Fritz.", "hint": cluster.hint_for(output),
                                   "needsPassphrase": "passphrase" in output.lower(), "output": output.strip()[-cluster.MAX_OUTPUT:]})
        cases = cluster.parse_cases(output)
        results = cluster.parse_results(output)
        for case in cases:
            case["results"] = results.get(case["name"])
        Handler.remote_cases = {case["name"] for case in cases}
        Handler.remote_info = {case["name"]: case for case in cases}
        queue = jobs.get("result")
        for case in cases:
            case["jobs"] = (queue or {}).get(case["name"], [])
            case["submittedJob"] = self.submitted.get(case["name"])
        folders = self.working_dir.cfd_folders()
        for case in cases:
            case["local"] = None
            try:
                cluster.check_case_name(case["name"])
            except ValueError:
                case["downloadable"] = False
                continue
            case["downloadable"] = True
            if folders and (folders[0] / case["name"]).exists():
                case["local"] = "finished"
            elif folders and (folders[1] / case["name"]).exists():
                case["local"] = "partial"
            download = self.downloads.get(case["name"])
            case["download"] = download.describe() if download else None
        self.send_json({"ok": True, "cases": cases, "checkedAt": time.time(), "canDownload": folders is not None,
                        "canSubmit": bool(saved["submitSession"]), "jobsChecked": queue is not None,
                        "templateFolder": saved["templateFolder"]})

    def api_cluster_downloads(self, _path):
        self.send_json({case: download.describe() for case, download in self.downloads.items()})

    def api_cluster_download(self, body):
        """Start downloading one case (skipping .sim unless includeSim)."""
        try:
            case = cluster.check_case_name(body.get("case"))
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        if case not in Handler.remote_cases:
            return self.send_json({"error": "That case is not in the last list from Fritz; refresh first."}, HTTPStatus.BAD_REQUEST)
        folders = self.working_dir.cfd_folders()
        if folders is None:
            return self.send_json({"error": "Set the working directory to the CFD-Tool folder that contains finished "
                                            "(and inProgress) to download."}, HTTPStatus.BAD_REQUEST)
        finished, partial = folders[0] / case, folders[1] / case
        if finished.exists():
            return self.send_json({"error": f"{case} is already in finished."}, HTTPStatus.CONFLICT)
        saved = self.cluster_settings()
        with self.download_lock:
            if any(download.state == "running" for download in self.downloads.values()):
                return self.send_json({"error": "Another download is running; wait for it or cancel it."}, HTTPStatus.CONFLICT)
            download = cluster.Download(case, body.get("includeSim") is True)
            self.downloads[case] = download
        lines = cluster.download_script(saved["session"], saved["remoteFolder"], case, str(partial), download.include_sim)
        threading.Thread(target=cluster.run_download, args=(self.winscp, download, lines, partial, finished), daemon=True).start()
        self.send_json(download.describe())

    def api_settings_file(self, body):
        """Settings of the template folder or an existing case on Fritz, as pairs."""
        saved = self.cluster_settings()
        try:
            source = cluster.check_case_name(body.get("source") or saved["templateFolder"])
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        if not saved["session"] or not saved["remoteFolder"]:
            return self.send_json({"error": "Save your WinSCP session and remote folder first."}, HTTPStatus.BAD_REQUEST)
        if source != saved["templateFolder"] and source not in Handler.remote_cases:
            return self.send_json({"error": "That case is not in the last list from Fritz; refresh first."}, HTTPStatus.BAD_REQUEST)
        handle, local = tempfile.mkstemp(prefix="homo-cfd-settings-")
        os.close(handle)
        try:
            code, output = self.winscp.run(cluster.settings_fetch_script(saved["session"], saved["remoteFolder"], source, local))
            text = Path(local).read_text(encoding="utf-8", errors="replace") if code == 0 else ""
        finally:
            os.unlink(local)
        pairs = cluster.parse_settings(text)
        if not pairs:
            return self.send_json({"error": f"Could not read {source}/Settings on Fritz.", "hint": cluster.hint_for(output)},
                                  HTTPStatus.BAD_GATEWAY)
        self.send_json({"source": source, "settings": pairs})

    def api_browse_sim(self, body):
        if not dialogs_available():
            return self.send_json({"error": "File dialog unavailable; type the path instead."}, HTTPStatus.NOT_IMPLEMENTED)
        if not self.browse_lock.acquire(blocking=False):
            return self.send_json({"error": "A file dialog is already open."}, HTTPStatus.CONFLICT)
        try:
            chosen = browse_for_sim(body.get("initial") if isinstance(body.get("initial"), str) else None)
        except (OSError, RuntimeError):
            return self.send_json({"error": "The file dialog could not open; type the path instead."}, HTTPStatus.NOT_IMPLEMENTED)
        finally:
            self.browse_lock.release()
        if not chosen:
            return self.send_json({"cancelled": True})
        path = Path(chosen)
        self.send_json({"path": str(path), "size": path.stat().st_size if path.is_file() else None})

    def api_new_case_tasks(self, _path):
        self.send_json({case: task.describe() for case, task in self.creating.items()})

    def api_new_case(self, body):
        """Create a case on Fritz from the template, with edited Settings and a .sim."""
        saved = self.cluster_settings()
        try:
            case = cluster.check_case_name(body.get("name"))
            pairs = cluster.check_settings(body.get("settings"))
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        sim = Path(body["simPath"].strip().strip('"')) if isinstance(body.get("simPath"), str) and body["simPath"].strip() else None
        if sim is None or not sim.is_absolute() or not sim.is_file() or sim.suffix.lower() != ".sim" or cluster.UNSAFE.search(str(sim)):
            return self.send_json({"error": "Choose the base .sim file on this computer."}, HTTPStatus.BAD_REQUEST)
        if not saved["session"] or not saved["remoteFolder"]:
            return self.send_json({"error": "Save your WinSCP session and remote folder first."}, HTTPStatus.BAD_REQUEST)
        if case in Handler.remote_cases or case == saved["templateFolder"]:
            return self.send_json({"error": f"{case} already exists on Fritz."}, HTTPStatus.CONFLICT)
        with self.download_lock:
            if any(task.state == "running" for task in self.creating.values()):
                return self.send_json({"error": "Another new simulation is being created; wait for it."}, HTTPStatus.CONFLICT)
            task = cluster.Download(case)
            task.bytes_total = sim.stat().st_size
            self.creating[case] = task
        handle, settings_file = tempfile.mkstemp(prefix="homo-cfd-settings-")
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as file:
            file.write(cluster.format_settings(pairs))
        threading.Thread(target=cluster.run_new_case, daemon=True, args=(
            self.winscp, task, saved["session"], saved["remoteFolder"], saved["templateFolder"], case, settings_file, str(sim))).start()
        self.send_json(task.describe())

    def api_submit(self, body):
        """Start a prepared case: sbatch mesh.sh with the job session. Never twice."""
        saved = self.cluster_settings()
        try:
            case = cluster.check_case_name(body.get("case"))
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        if not saved["submitSession"]:
            return self.send_json({"error": "Choose the session for starting jobs (your Fritz login node) and save."}, HTTPStatus.BAD_REQUEST)
        info = Handler.remote_info.get(case)
        if info is None:
            return self.send_json({"error": "That case is not in the last list from Fritz; refresh first."}, HTTPStatus.BAD_REQUEST)
        if info["state"] != "prepared" or info.get("jobs") or case in self.submitted:
            return self.send_json({"error": f"{case} has already been started."}, HTTPStatus.CONFLICT)
        task = self.creating.get(case)
        if task is not None and task.state != "done":
            return self.send_json({"error": f"{case} was not created completely; it cannot be started."}, HTTPStatus.CONFLICT)
        with self.download_lock:
            if case in self.submitted:
                return self.send_json({"error": f"{case} has already been started."}, HTTPStatus.CONFLICT)
            self.submitted[case] = None
        code, output = self.winscp.run(cluster.submit_script(saved["submitSession"], saved["remoteFolder"], case))
        match = cluster.SUBMITTED.search(output)
        if code == 0 and match:
            self.submitted[case] = match.group(1)
            return self.send_json({"ok": True, "jobId": match.group(1)})
        del self.submitted[case]
        self.send_json({"ok": False, "error": "Fritz did not accept the job.", "hint": cluster.hint_for(output),
                        "output": output.strip()[-cluster.MAX_OUTPUT:]})

    def api_cluster_cancel(self, body):
        download = self.downloads.get(body.get("case")) if isinstance(body.get("case"), str) else None
        if download is None or download.state != "running":
            return self.send_json({"error": "No download of that case is running."}, HTTPStatus.BAD_REQUEST)
        download.cancel()
        self.send_json(download.describe())

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
        """The nested listing of a folder. For the results folder itself, cached=1 answers
        {"tree", "cached"} from the saved copy when there is one (see TreeCache); every
        scan of the results folder updates that copy."""
        target = self.results_path(relative)
        if target is None:
            return
        if not target.is_dir():
            return self.send_json({"error": "Not a folder."}, HTTPStatus.BAD_REQUEST)
        wrapped = parse_qs(urlsplit(self.path).query).get("cached") == ["1"]
        is_root = relative.strip("/") == ""
        if wrapped and is_root:
            saved = Handler.tree_cache.get(str(target))
            if saved is not None:
                return self.send_json({"tree": saved, "cached": True})
        tree = scan_tree(target)
        if is_root:
            Handler.tree_cache.put(str(target), tree)
        self.send_json({"tree": tree, "cached": False} if wrapped else tree)

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
    parser.add_argument("--background", action="store_true",
                        help=f"no console window: log to {user_config_dir() / 'homo-cfd.log'} and stop "
                             f"{IDLE_MINUTES} min after the last HoMo CFD window closed")
    args = parser.parse_args()
    if args.background:
        # pythonw has no console (sys.stdout/stderr are None); keep the output in a log file.
        log = user_config_dir() / "homo-cfd.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = open(log, "w", encoding="utf-8", buffering=1)

    path, source = find_working_dir(args.working_dir)
    # Stop WinSCP downloads when HoMo CFD stops; they resume next time.
    atexit.register(lambda: [download.cancel() for download in Handler.downloads.values()])
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
    print("Stop with Ctrl+C" if not args.background else
          f"Running in the background; stops {IDLE_MINUTES} min after the last window closed, or with Quit in the app.")
    if args.background:
        def watch():
            while True:
                time.sleep(30)
                if should_stop(Handler.last_seen, time.monotonic(), Handler.busy()):
                    print("No HoMo CFD window for a while; stopping.")
                    server.shutdown()
                    return
        threading.Thread(target=watch, daemon=True).start()
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
