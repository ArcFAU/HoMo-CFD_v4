"""Fritz cluster access through WinSCP (Stage 7). Python 3 stdlib only.

HoMo CFD never stores passwords or keys. Each user keeps their Fritz login in
a WinSCP *saved session* (host, user name, key); HoMo CFD only stores that
session's name and the remote folder, in %APPDATA%\\HoMo-CFD\\settings.json.

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

# Known WinSCP messages and what the user can do about them.
HINTS = [
    ("host key", "WinSCP does not know Fritz's host key yet. Open WinSCP, log in with this session once and accept the key, then test again."),
    ("authentication failed", "Fritz refused the login. Check the user name and key in this WinSCP session (log in with WinSCP to try it)."),
    ("passphrase", "The key needs a passphrase, which HoMo CFD cannot type. Load the key into Pageant first, or log in with WinSCP to check."),
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

    def sessions(self):
        """Names of the WinSCP saved sessions (from the registry), sorted."""
        try:
            import winreg
        except ImportError:
            return []
        names = []
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Martin Prikryl\WinSCP 2\Sessions") as key:
                index = 0
                while True:
                    try:
                        names.append(unquote(winreg.EnumKey(key, index)))
                    except OSError:
                        break
                    index += 1
        except OSError:
            return []
        return sorted((name for name in names if name != "Default Settings"), key=str.lower)

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
    return {"ok": False, "error": "Could not connect with this session.", "hint": hint_for(output), "output": output}
