"""Fritz cluster access through WinSCP (Stage 7). Python 3 stdlib only.

HoMo CFD never stores passwords or keys. Each user keeps their Fritz login in
a WinSCP *saved session* (host, user name, key); HoMo CFD only stores that
session's name and the remote folder, in %APPDATA%\\HoMo-CFD\\settings.json.
A key with a passphrase is unlocked in Pageant (PuTTY's key agent), which
asks for the passphrase in its own window; WinSCP then uses Pageant.

WinSCP.com runs only when the user asks for it in the app. See
docs/STAGE7_FRITZ.md for the design.
"""

import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import quote, unquote

# Control characters and double quotes would break a WinSCP script line.
UNSAFE = re.compile(r'["\x00-\x1f\x7f]')
MAX_OUTPUT = 4000
TIMEOUT_SECONDS = 90

SESSIONS_KEY = r"Software\Martin Prikryl\WinSCP 2\Sessions"

# Known WinSCP messages and what the user can do about them; first match wins.
HINTS = [
    ("no 'sbatch' command", "This session logs in to csnhr, NHR's jump host, which cannot start jobs. "
                            "Under \"Session for starting jobs\", choose your session to fritz.nhr.fau.de, then save."),
    ("passphrase", "Your key is protected by a passphrase, which HoMo CFD never types. Click \"Unlock key with Pageant\": "
                   "Pageant asks for the passphrase in its own window, then WinSCP can use the key. Then test again."),
    ("host key", "WinSCP does not know Fritz's host key yet. Open WinSCP, log in with this session once and accept the key, then test again."),
    ("authentication failed", "Fritz refused the login. Check the user name and key in this WinSCP session (log in with WinSCP to try it)."),
    ("password", "The session asks for a password, which HoMo CFD cannot type. Use a key (as with CFD-Tool), or log in with WinSCP to check."),
    ("changing directory", "Logged in, but the remote folder could not be opened. Check the path."),
    ("does not exist", "WinSCP found no saved session or host with this name. Check the session name in WinSCP."),
    ("refused", "Fritz turned the connection away. NHR's jump host does this now and then when logins come in quick "
                "succession. Wait a minute, then try again."),
    ("network error", "Could not reach Fritz. Check the network or VPN connection."),
    ("connection failed", "Could not reach Fritz. Check the network or VPN connection."),
    ("timed out", "Fritz did not answer in time. Check the network or VPN connection."),
]


def check_session(value):
    """A saved-session name as typed or chosen; returns it or raises ValueError."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Choose a WinSCP session.")
    value = value.strip()
    if len(value) > 200 or UNSAFE.search(value):
        raise ValueError("That session name cannot be used.")
    return value


def check_remote_folder(value):
    """An optional absolute remote folder (/… or ~/…); returns "" when empty."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return ""
    if not isinstance(value, str):
        raise ValueError("Invalid remote folder.")
    value = value.strip()
    if len(value) > 500 or UNSAFE.search(value) or not value.startswith(("/", "~")):
        raise ValueError("The remote folder must be a path like /home/vault/…/Pipeline.")
    return value


def open_command(session):
    """Log in with a saved session. HoMo CFD only uses full paths, so the
    session's own local folder is replaced by the temp folder: WinSCP stops a
    script when that folder no longer exists (e.g. a moved results folder)."""
    return f'open "{session}" -rawsettings LocalDirectory="{quote(tempfile.gettempdir(), safe=":")}"'


def test_script(session, remote_folder=""):
    """WinSCP script that logs in, changes to the folder and prints it.

    Read-only: nothing is uploaded, downloaded, started or deleted.
    """
    lines = ["option batch abort", "option confirm off", open_command(session)]
    if remote_folder:
        lines.append(f'cd "{remote_folder}"')
    lines += ["pwd", "exit"]
    return lines


def hint_for(output):
    lowered = output.lower()
    return next((hint for needle, hint in HINTS if needle in lowered), "")


class WinScp:
    """The user's WinSCP installation. Tests replace this with a fake."""

    def executable(self):
        candidates = [
            Path(base) / "WinSCP" / "WinSCP.com"
            for base in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"))
            if base
        ]
        if os.environ.get("LOCALAPPDATA"):
            candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "WinSCP" / "WinSCP.com")
        found = shutil.which("WinSCP.com")
        if found:
            candidates.append(Path(found))
        return next((path for path in candidates if path.is_file()), None)

    def registry_sessions(self):
        """{decoded session name: registry key name}; WinSCP %-encodes the names."""
        try:
            import winreg
        except ImportError:
            return {}
        found = {}
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, SESSIONS_KEY) as key:
                index = 0
                while True:
                    try:
                        raw = winreg.EnumKey(key, index)
                    except OSError:
                        break
                    found[unquote(raw)] = raw
                    index += 1
        except OSError:
            return {}
        found.pop("Default Settings", None)
        return found

    def sessions(self):
        """Names of the WinSCP saved sessions (from the registry), sorted."""
        return sorted(self.registry_sessions(), key=str.lower)

    def session_value(self, session, field):
        """One stored value of a saved session (e.g. HostName), or None."""
        raw = self.registry_sessions().get(session)
        if raw is None:
            return None
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, SESSIONS_KEY + "\\" + raw) as key:
                return winreg.QueryValueEx(key, field)[0]
        except OSError:
            return None

    def session_hosts(self):
        """{session name: host name} for the saved sessions that have one."""
        hosts = {name: self.session_value(name, "HostName") for name in self.sessions()}
        return {name: host for name, host in hosts.items() if isinstance(host, str) and host}

    def session_key_file(self, session):
        """The private key file set in a saved session, or None."""
        value = self.session_value(session, "PublicKeyFile")
        value = unquote(value) if isinstance(value, str) else ""
        return Path(value) if value and Path(value).is_file() else None

    def pageant(self):
        """pageant.exe from PuTTY or from WinSCP's own PuTTY folder, or None."""
        candidates = [
            Path(base) / "PuTTY" / "pageant.exe"
            for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"))
            if base
        ]
        executable = self.executable()
        if executable:
            candidates.append(executable.parent / "PuTTY" / "pageant.exe")
        found = shutil.which("pageant.exe")
        if found:
            candidates.append(Path(found))
        return next((path for path in candidates if path.is_file()), None)

    def pageant_running(self):
        try:
            listed = subprocess.run(["tasklist", "/FI", "IMAGENAME eq pageant.exe", "/NH"], capture_output=True, timeout=15,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired):
            return False
        return b"pageant.exe" in listed.stdout.lower()

    def start_pageant(self, key_file):
        """Start Pageant with a key; Pageant itself asks for the passphrase.

        If Pageant is already running, the new process hands the key to it.
        """
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen([str(self.pageant()), str(key_file)], creationflags=flags, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def run(self, lines):
        """Run a WinSCP script; returns (exit code, console output)."""
        executable = self.executable()
        if executable is None:
            return None, "WinSCP.com not found."
        handle, script = tempfile.mkstemp(prefix="homo-cfd-winscp-", suffix=".txt")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                file.write("\n".join(lines) + "\n")
            completed = subprocess.run(
                [str(executable), "/nointeractiveinput", f"/script={script}"],
                capture_output=True, timeout=TIMEOUT_SECONDS,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            output = (completed.stdout + completed.stderr).decode("utf-8", errors="replace")
            return completed.returncode, output
        except subprocess.TimeoutExpired:
            return None, f"WinSCP did not finish within {TIMEOUT_SECONDS} s (timed out)."
        finally:
            os.unlink(script)

    def stream(self, lines, on_line, on_start=lambda process: None):
        """Run a long WinSCP script (no timeout), passing each output line to
        on_line; on_start receives the process so it can be cancelled.
        Returns the exit code."""
        executable = self.executable()
        if executable is None:
            on_line("WinSCP.com not found.")
            return None
        handle, script = tempfile.mkstemp(prefix="homo-cfd-winscp-", suffix=".txt")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                file.write("\n".join(lines) + "\n")
            process = subprocess.Popen(
                [str(executable), "/nointeractiveinput", f"/script={script}"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            on_start(process)
            for raw in process.stdout:
                on_line(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
            return process.wait()
        finally:
            try:
                os.unlink(script)
            except OSError:
                pass


def test_connection(winscp, session, remote_folder=""):
    """Log in with the saved session and print the remote folder."""
    code, output = winscp.run(test_script(session, remote_folder))
    output = output.strip()[-MAX_OUTPUT:]
    if code == 0:
        lines = [line.strip() for line in output.splitlines() if line.strip().startswith(("/", "~"))]
        return {"ok": True, "remoteFolder": lines[-1] if lines else remote_folder, "output": output}
    return {"ok": False, "error": "Could not connect with this session.", "hint": hint_for(output),
            "needsPassphrase": "passphrase" in output.lower(), "output": output}


# --- Step 2: status of the cases on Fritz and downloads -------------------

CASE_PREFIX = "HOMO|"
TOTAL_PREFIX = "HOMO-TOTAL|"
STALE_HOURS = 12
# One line per transferred file: "name | 261 KB | 4875.3 KB/s | binary | 100%".
FILE_LINE = re.compile(r"\|\s*(?:binary|ascii)\s*\|\s*\d+%\s*$")
# Never downloaded: STAR-CCM+ backups, job scripts and macros (the scripts
# contain the licence key), CFD-Tool's abort markers. *.sim (10-20 GB) only
# on request.
EXCLUDED = ["*.sim~", "*.sh", "*.java", "ABORT*"]


def case_status_command():
    """Read-only shell command reporting each case folder in the remote folder.

    Prints "HOMO|<name>|<flags>|<newest job log, epoch s>" per folder that has
    Settings, STARTED or plots. Flags: S STARTED, D plots/DONE (solver
    finished), X plots/POST_DONE, M meshing log, T solver log, R post log,
    P newest post log finished ("Job finished at", written last by post.sh).
    """
    return (
        'for d in */; do d="${d%/}"; '
        '[ -e "$d/Settings" ] || [ -e "$d/STARTED" ] || [ -d "$d/plots" ] || continue; f=; '
        '[ -e "$d/STARTED" ] && f="${f}S"; [ -e "$d/plots/DONE" ] && f="${f}D"; '
        '[ -e "$d/plots/POST_DONE" ] && f="${f}X"; '
        'ls "$d"/mesh.o* >/dev/null 2>&1 && f="${f}M"; ls "$d"/resTAURANtS.o* >/dev/null 2>&1 && f="${f}T"; '
        'p=$(ls -t "$d"/post.o* 2>/dev/null | head -n 1); '
        'if [ -n "$p" ]; then f="${f}R"; tail -c 4000 "$p" | grep -q "Job finished at" && f="${f}P"; fi; '
        'l=$(ls -t "$d"/*.o* 2>/dev/null | head -n 1); t=0; [ -n "$l" ] && t=$(stat -c %Y "$l"); '
        f'echo "{CASE_PREFIX}$d|$f|$t"; done'
    )


def status_script(session, remote_folder):
    return ["option batch abort", "option confirm off", open_command(session), f'cd "{remote_folder}"',
            f"call {case_status_command()}", "exit"]


def case_state(flags):
    """prepared → meshing → solving → waiting-post → post → ready."""
    if "X" in flags or "P" in flags:
        return "ready"
    if "D" in flags:
        return "post" if "R" in flags else "waiting-post"
    if "S" in flags:
        return "solving" if "T" in flags else "meshing"
    return "prepared"


def parse_cases(output, now=None):
    """Cases from the status command's output, newest activity first.

    "stale": not finished, and no job log changed for STALE_HOURS (a run that
    died leaves no marker, so this is the only hint that it stopped).
    """
    now = time.time() if now is None else now
    cases = []
    for line in output.splitlines():
        if not line.startswith(CASE_PREFIX):
            continue
        parts = line[len(CASE_PREFIX):].rsplit("|", 2)
        if len(parts) != 3 or not parts[0] or not parts[2].isdigit():
            continue
        name, flags, stamp = parts
        state, last_log = case_state(flags), int(stamp) or None
        stale = state not in ("ready", "prepared") and last_log is not None and now - last_log > STALE_HOURS * 3600
        cases.append({"name": name, "flags": flags, "state": state, "lastLog": last_log, "stale": stale})
    return sorted(cases, key=lambda case: (-(case["lastLog"] or 0), case["name"].lower()))


def check_case_name(name):
    """A remote case folder name that is safe to use in paths and scripts."""
    if (not isinstance(name, str) or not name or name in (".", "..") or name.startswith(".")
            or len(name) > 200 or UNSAFE.search(name) or any(c in name for c in '/\\:*?<>|')):
        raise ValueError("Invalid case name.")
    return name


def download_script(session, remote_folder, case, local_dir, include_sim=False):
    """Count the files to fetch, then synchronize the case folder into local_dir.

    "synchronize local" only writes on this computer: it skips files that are
    already complete (so an interrupted download resumes) and never deletes
    anything on Fritz.
    """
    excluded = EXCLUDED + ([] if include_sim else ["*.sim"])
    find_filters = " ".join(f'! -name "{pattern}"' for pattern in excluded)
    remote_case = f"{remote_folder}/{case}"
    return [
        "option batch abort", "option confirm off", open_command(session),
        f'call cd "{remote_case}" && find . -type f {find_filters} -printf "%s\\n" | '
        f"awk '{{n++; b+=$1}} END {{print \"{TOTAL_PREFIX}\" n+0 \"|\" b+0}}'",
        f'synchronize local -filemask="|{"; ".join(excluded)}" "{local_dir}" "{remote_case}"',
        "exit",
    ]


class Download:
    """Progress of one background download (read by the app every few seconds)."""

    def __init__(self, case, include_sim=False):
        self.case, self.include_sim = case, include_sim
        self.state = "running"
        self.files_done = 0
        self.files_total = None
        self.bytes_total = None
        self.message = ""
        self.process = None
        self.cancelled = False
        self.log = []

    def on_line(self, line):
        self.log = (self.log + [line])[-60:]
        if line.startswith(TOTAL_PREFIX):
            count, size = (line[len(TOTAL_PREFIX):].split("|") + ["", ""])[:2]
            self.files_total = int(count) if count.isdigit() else None
            self.bytes_total = int(size) if size.isdigit() else None
        elif FILE_LINE.search(line):
            self.files_done += 1

    def cancel(self):
        self.cancelled = True
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()

    def describe(self):
        return {"case": self.case, "state": self.state, "filesDone": self.files_done,
                "filesTotal": self.files_total, "bytesTotal": self.bytes_total,
                "message": self.message, "includeSim": self.include_sim}


def run_download(winscp, download, lines, partial_dir, finished_dir):
    """Download into inProgress/<case>, then move it to finished/<case>.

    Like CFD-Tool, a case only appears in finished/ once it is complete; an
    interrupted download stays in inProgress/ and resumes from there.
    """
    try:
        partial_dir.mkdir(parents=True, exist_ok=True)
        code = winscp.stream(lines, download.on_line, lambda process: setattr(download, "process", process))
        if download.cancelled:
            download.state = "cancelled"
            download.message = "Cancelled. The files so far stay in inProgress; Download resumes from there."
        elif code != 0:
            download.state = "failed"
            output = "\n".join(download.log)
            download.message = " ".join(filter(None, ["The download stopped.", hint_for(output)]))
        elif finished_dir.exists():
            download.state = "failed"
            download.message = f"{finished_dir} already exists; the download is kept in {partial_dir}."
        else:
            os.replace(partial_dir, finished_dir)
            download.state = "done"
            download.message = "Downloaded to finished."
    except Exception as err:  # never leave a download shown as running
        download.state = "failed"
        download.message = f"Could not save the download: {err}"


# --- Steps 3-4: new simulations from the team template, starting jobs --------
#
# The team prepares a case by copying the template folder on Fritz (by default
# SCRIPT_FABSI: Settings, mesh/rans/postprocessing.java, mesh/rans/post.sh,
# which already contain the licence key) into a new folder, adding the base
# .sim and adjusting Settings. Jobs are started with "sbatch mesh.sh" from a
# Fritz login node; the jump host has no SLURM, so starting and the queue use
# a second WinSCP session ("session for starting jobs").

DEFAULT_TEMPLATE = "SCRIPT_FABSI"
JOB_PREFIX = "HOMO-JOB|"
SUBMITTED = re.compile(r"Submitted batch job (\d+)")


def parse_settings(text):
    """[(key, value), ...] from a Settings file ("Group/Name : value" lines)."""
    pairs = []
    for line in text.splitlines():
        if " : " in line:
            key, value = line.split(" : ", 1)
            pairs.append((key.strip(), value.strip()))
    return pairs


def check_settings(pairs):
    """Validated [(key, value)] for writing a Settings file; raises ValueError."""
    if not isinstance(pairs, list) or not pairs or len(pairs) > 2000:
        raise ValueError("Settings are missing.")
    checked = []
    for pair in pairs:
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2 and all(isinstance(part, str) for part in pair)):
            raise ValueError("Invalid Settings entry.")
        key, value = pair[0].strip(), pair[1].strip()
        if not key or " : " in key or " : " in value or re.search(r"[\x00-\x1f]", key + value):
            raise ValueError(f"Invalid Settings entry: {key or '(empty)'}")
        checked.append((key, value))
    return checked


def format_settings(pairs):
    return "".join(f"{key} : {value}\n" for key, value in pairs)


def settings_fetch_script(session, remote_folder, source, local_file):
    """Download <source>/Settings (read-only on Fritz)."""
    return ["option batch abort", "option confirm off", open_command(session),
            f'get "{remote_folder}/{source}/Settings" "{local_file}"', "exit"]


TEMPLATE_FETCHED = "HOMO-TEMPLATE-FETCHED"
FOLDER_CREATED = "HOMO-CREATED"
CASE_UPLOADED = "HOMO-UPLOADED"


def new_case_script(session, remote_folder, template, case, template_dir, settings_file, sim_file):
    """Create <case> as a copy of the template with the edited Settings and the .sim.

    One login and only WinSCP's own commands: "call" (a shell command) needs a
    second login, which NHR's jump host sometimes refuses, and does not stop
    the script when it fails. WinSCP's own commands do stop it (option batch
    abort), so "mkdir" is the guard: it fails if <case> exists, and nothing
    after it runs. The template's few small files (never a .sim) pass through
    template_dir on this computer; the echo lines mark how far the script got.
    """
    return [
        "option batch abort", "option confirm off", open_command(session), f'cd "{remote_folder}"',
        f'get -filemask="|*.sim; *.sim~" "{template}/*" "{template_dir}\\"',
        f"echo {TEMPLATE_FETCHED}",
        f'mkdir "{case}"',
        f"echo {FOLDER_CREATED}",
        f'put -filemask="|Settings" "{template_dir}\\*" "{case}/"',
        f'put "{settings_file}" "{case}/Settings"',
        f'put "{sim_file}" "{case}/"',
        f"echo {CASE_UPLOADED}",
        "exit",
    ]


def submit_script(session, remote_folder, case):
    """Start the job chain: mesh.sh submits rans.sh, which submits post.sh."""
    return ["option batch abort", "option confirm off", open_command(session),
            f'call cd "{remote_folder}/{case}" && sbatch mesh.sh', "exit"]


def submit_test_script(session, remote_folder):
    """Read-only check that the session can use SLURM."""
    lines = ["option batch abort", "option confirm off", open_command(session)]
    if remote_folder:
        lines.append(f'cd "{remote_folder}"')
    return lines + ["call sbatch --version", "exit"]


def jobs_script(session):
    """Your queued and running jobs with their working folders (read-only)."""
    return ["option batch abort", "option confirm off", open_command(session),
            f'call squeue -u $USER -h -o "{JOB_PREFIX}%i|%j|%T|%M|%Z"', "exit"]


def parse_jobs(output):
    """{case folder name: [{id, name, state, elapsed}]} from squeue output."""
    jobs = {}
    for line in output.splitlines():
        if not line.startswith(JOB_PREFIX):
            continue
        parts = line[len(JOB_PREFIX):].split("|", 4)
        if len(parts) != 5:
            continue
        job_id, name, state, elapsed, workdir = parts
        folder = workdir.rstrip("/").rsplit("/", 1)[-1]
        jobs.setdefault(folder, []).append({"id": job_id, "name": name, "state": state, "elapsed": elapsed})
    return jobs


def run_new_case(winscp, task, session, remote_folder, template, case, settings_file, sim_file):
    """Background task: create the case on Fritz in one WinSCP run (see
    new_case_script), then remove the temporary Settings and template files."""
    template_dir = tempfile.mkdtemp(prefix="homo-cfd-template-")
    reached = set()
    steps = {TEMPLATE_FETCHED: "Creating the folder…", FOLDER_CREATED: "Uploading Settings and the .sim file…"}

    def on_line(line):
        task.on_line(line)
        mark = line.strip()
        if mark in (TEMPLATE_FETCHED, FOLDER_CREATED, CASE_UPLOADED):
            reached.add(mark)
            task.message = steps.get(mark, task.message)

    try:
        task.message = f"Reading the template folder {template}…"
        code = winscp.stream(new_case_script(session, remote_folder, template, case, template_dir, settings_file, sim_file),
                             on_line, lambda process: setattr(task, "process", process))
        log = "\n".join(task.log)
        hint = hint_for(log)
        if code == 0 and CASE_UPLOADED in reached:
            task.state, task.message = "done", "Created on Fritz. Start it from the list when you are ready."
        elif FOLDER_CREATED in reached:
            task.state = "cancelled" if task.cancelled else "failed"
            stopped = "Cancelled during the upload." if task.cancelled else "The upload stopped."
            task.message = " ".join(filter(None, [f"{stopped} The folder {case} exists on Fritz but is incomplete; "
                                                  "do not start it.", hint]))
        else:
            task.state = "cancelled" if task.cancelled else "failed"
            if task.cancelled:
                reason = "Cancelled."
            elif TEMPLATE_FETCHED in reached:
                reason = f"Could not create the folder {case} on Fritz; a folder with this name probably exists already."
            elif re.search(r"no such file|no file matching|not found", log, re.I) and not hint:
                reason = f"The template folder {template} was not found on Fritz."
            else:
                reason = f"Could not read the template folder {template} on Fritz."
            task.message = " ".join(filter(None, [reason, "Nothing was changed on Fritz.", hint]))
    except Exception as err:  # never leave a task shown as running
        task.state = "failed"
        task.message = f"Could not create the case: {err}"
    finally:
        shutil.rmtree(template_dir, ignore_errors=True)
        try:
            os.unlink(settings_file)
        except OSError:
            pass
