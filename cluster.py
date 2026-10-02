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
from pathlib import Path
from urllib.parse import unquote

# Control characters and double quotes would break a WinSCP script line.
UNSAFE = re.compile(r'["\x00-\x1f\x7f]')
MAX_OUTPUT = 4000
TIMEOUT_SECONDS = 90

SESSIONS_KEY = r"Software\Martin Prikryl\WinSCP 2\Sessions"

# Known WinSCP messages and what the user can do about them; first match wins.
HINTS = [
    ("passphrase", "Your key is protected by a passphrase, which HoMo CFD never types. Click \"Unlock key with Pageant\": "
                   "Pageant asks for the passphrase in its own window, then WinSCP can use the key. Then test again."),
    ("host key", "WinSCP does not know Fritz's host key yet. Open WinSCP, log in with this session once and accept the key, then test again."),
    ("authentication failed", "Fritz refused the login. Check the user name and key in this WinSCP session (log in with WinSCP to try it)."),
    ("password", "The session asks for a password, which HoMo CFD cannot type. Use a key (as with CFD-Tool), or log in with WinSCP to check."),
    ("changing directory", "Logged in, but the remote folder could not be opened. Check the path."),
    ("does not exist", "WinSCP found no saved session or host with this name. Check the session name in WinSCP."),
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


def test_script(session, remote_folder=""):
    """WinSCP script that logs in, changes to the folder and prints it.

    Read-only: nothing is uploaded, downloaded, started or deleted.
    """
    lines = ["option batch abort", "option confirm off", f'open "{session}"']
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

    def session_key_file(self, session):
        """The private key file set in a saved session, or None."""
        raw = self.registry_sessions().get(session)
        if raw is None:
            return None
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, SESSIONS_KEY + "\\" + raw) as key:
                value = unquote(winreg.QueryValueEx(key, "PublicKeyFile")[0])
        except OSError:
            return None
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


def test_connection(winscp, session, remote_folder=""):
    """Log in with the saved session and print the remote folder."""
    code, output = winscp.run(test_script(session, remote_folder))
    output = output.strip()[-MAX_OUTPUT:]
    if code == 0:
        lines = [line.strip() for line in output.splitlines() if line.strip().startswith(("/", "~"))]
        return {"ok": True, "remoteFolder": lines[-1] if lines else remote_folder, "output": output}
    return {"ok": False, "error": "Could not connect with this session.", "hint": hint_for(output),
            "needsPassphrase": "passphrase" in output.lower(), "output": output}
