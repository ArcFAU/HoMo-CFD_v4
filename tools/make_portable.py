"""Build the portable HoMo CFD for teammates: the app plus its own Python.

    py tools/make_portable.py

Makes dist/HoMo-CFD/ and dist/HoMo-CFD-portable.zip. A teammate unzips it
anywhere and double-clicks "Start HoMo CFD.bat"; nothing has to be installed.
Python 3 stdlib only; needs internet the first time to download Python's
Windows embeddable package from python.org (cached in dist/cache/ and checked
against its SHA-256, which matches python.org's published SBOM).
"""

import hashlib
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP = DIST / "HoMo-CFD"
ARCHIVE = DIST / "HoMo-CFD-portable.zip"

PYTHON_VERSION = "3.14.8"
PYTHON_ZIP = f"python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{PYTHON_ZIP}"
PYTHON_SHA256 = "a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310"

# What a teammate needs to run the app; never tests, notes, data or secrets.
APP_FILES = ["serve.py", "cluster.py", "Start HoMo CFD.bat", "README.md"]
# starccm/: the STAR-CCM+ macros for the 3D export, which teammates add to their own template.
APP_FOLDERS = ["web", "starccm"]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def python_package(cache=DIST / "cache"):
    """The embeddable package, downloaded once and verified."""
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / PYTHON_ZIP
    if not path.is_file():
        print(f"Downloading {PYTHON_URL} …")
        partial = path.with_suffix(".part")
        with urllib.request.urlopen(PYTHON_URL, timeout=120) as response, open(partial, "wb") as file:
            shutil.copyfileobj(response, file)
        partial.replace(path)
    if sha256(path) != PYTHON_SHA256:
        path.unlink()
        raise SystemExit(f"{PYTHON_ZIP} does not match its expected SHA-256; deleted it. Run again to download it anew.")
    return path


def with_app_folder(pth_text):
    """The embeddable Python only searches the folders in its ._pth file, so
    add ".." (the app folder above python/) to let serve.py import cluster.py."""
    lines = pth_text.splitlines()
    if ".." not in (line.strip() for line in lines):
        lines.insert(lines.index(".") + 1 if "." in lines else len(lines), "..")
    return "\n".join(lines) + "\n"


def build(app=APP, archive=ARCHIVE, package=None, verify=None):
    package = package or python_package()
    if app.exists():
        if app.parent != DIST and not (app / "serve.py").is_file():
            raise SystemExit(f"Refusing to replace {app}: it does not look like an earlier build.")
        shutil.rmtree(app)
    app.mkdir(parents=True)
    for name in APP_FILES:
        shutil.copy2(ROOT / name, app / name)
        if name.endswith(".bat"):  # cmd.exe needs CRLF line endings
            text = (app / name).read_bytes().replace(b"\r\n", b"\n")
            (app / name).write_bytes(text.replace(b"\n", b"\r\n"))
    for name in APP_FOLDERS:
        shutil.copytree(ROOT / name, app / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    python = app / "python"
    with zipfile.ZipFile(package) as bundle:
        bundle.extractall(python)
    pth = next(python.glob("python*._pth"))
    pth.write_text(with_app_folder(pth.read_text(encoding="utf-8")), encoding="utf-8")
    (verify or check)(app)
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                out.write(path, Path(app.name) / path.relative_to(app))
    return archive


def check(app):
    """The bundled Python can load the app (its modules and folders)."""
    completed = subprocess.run(
        [str(app / "python" / "python.exe"), "-B", "-c",
         "import serve, cluster, sys; print(sys.version.split()[0], serve.dialogs_available(), serve.WEB.is_dir())"],
        cwd=app, capture_output=True, text=True, timeout=60,
    )
    if completed.returncode != 0 or not completed.stdout.strip().endswith("True True"):
        raise SystemExit(f"The portable Python cannot run HoMo CFD:\n{completed.stdout}{completed.stderr}")
    print("Bundled Python", completed.stdout.strip().split()[0], "loads HoMo CFD.")


if __name__ == "__main__":
    if sys.platform != "win32":
        raise SystemExit("The portable build is for Windows.")
    result = build()
    print(f"Done: {result} ({result.stat().st_size / 1e6:.1f} MB). Share this zip with your teammates.")
