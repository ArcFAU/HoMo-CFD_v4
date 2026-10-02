"""Tests for the portable build (tools/make_portable.py) and the dialogs it relies on.

The build is tested with a stand-in for Python's embeddable package, so these
tests need no internet and never run the downloaded python.exe.
"""

import base64
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "tools"))
import make_portable  # noqa: E402
import serve  # noqa: E402

PTH = "python314.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n"


class PortableBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="homo-cfd-portable-test-"))
        self.package = self.temp / "python-embed.zip"
        with zipfile.ZipFile(self.package, "w") as bundle:
            bundle.writestr("python.exe", b"stand-in")
            bundle.writestr("python314._pth", PTH)
            bundle.writestr("python314.zip", b"stdlib")

    def tearDown(self):
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_app_folder_is_added_to_python_path_once(self):
        patched = make_portable.with_app_folder(PTH)
        self.assertEqual(patched.splitlines()[:3], ["python314.zip", ".", ".."])
        self.assertEqual(make_portable.with_app_folder(patched), patched)
        self.assertIn("#import site", patched)

    def test_build_contains_the_app_and_python_only(self):
        checked = []
        archive = make_portable.build(self.temp / "HoMo-CFD", self.temp / "portable.zip", self.package, verify=checked.append)
        self.assertEqual(checked, [self.temp / "HoMo-CFD"])
        names = zipfile.ZipFile(archive).namelist()
        self.assertTrue(all(name.startswith("HoMo-CFD/") for name in names), names[:5])
        top = {name.split("/")[1] for name in names}
        self.assertEqual(top, {"serve.py", "cluster.py", "Start HoMo CFD.bat", "Create desktop shortcut.bat", "README.md", "web", "starccm", "python"})
        self.assertIn("HoMo-CFD/web/homo-cfd.ico", names)
        self.assertIn("HoMo-CFD/starccm/export3D.java", names)
        self.assertIn("HoMo-CFD/web/3d-viewer.js", names)
        self.assertFalse([name for name in names if "__pycache__" in name or name.endswith((".ppk", ".sim", ".pyc"))])
        with zipfile.ZipFile(archive) as built:
            self.assertEqual(built.read("HoMo-CFD/python/python314._pth").decode().splitlines()[:3], ["python314.zip", ".", ".."])
            bat = built.read("HoMo-CFD/Start HoMo CFD.bat")
        self.assertNotIn(b"\n", bat.replace(b"\r\n", b""), "CRLF line endings only")
        self.assertIn(b'start "" "python\\pythonw.exe" serve.py --open --background', bat,
                      "the start script prefers the bundled Python, without a console window")

    def test_rebuild_replaces_the_previous_build(self):
        app = self.temp / "HoMo-CFD"
        make_portable.build(app, self.temp / "portable.zip", self.package, verify=lambda _app: None, keep_folder=True)
        (app / "left-over.txt").write_text("old", encoding="utf-8")
        make_portable.build(app, self.temp / "portable.zip", self.package, verify=lambda _app: None, keep_folder=True)
        self.assertFalse((app / "left-over.txt").exists())
        make_portable.build(app, self.temp / "portable.zip", self.package, verify=lambda _app: None)
        self.assertFalse(app.exists(), "only the zip is kept")

    def test_wrong_download_is_rejected(self):
        cache = self.temp / "cache"
        cache.mkdir()
        (cache / make_portable.PYTHON_ZIP).write_bytes(b"not python")
        with self.assertRaises(SystemExit):
            make_portable.python_package(cache)
        self.assertFalse((cache / make_portable.PYTHON_ZIP).exists(), "a bad download is deleted")


class DialogFallbackTests(unittest.TestCase):
    """Without tkinter (the embeddable Python), Browse… uses PowerShell's Windows dialogs."""

    def run_dialog(self, stdout=b"", code=0):
        completed = subprocess.CompletedProcess([], code, stdout, b"boom")
        with mock.patch.object(serve, "powershell", return_value="powershell.exe"), \
                mock.patch.object(serve.subprocess, "run", return_value=completed) as run:
            try:
                return serve.powershell_dialog(serve.FOLDER_DIALOG, "Choose Working Directory", r"D:\CFD tool\Ü"), run
            except RuntimeError as err:
                return err, run

    def test_paths_travel_in_the_environment_not_the_command(self):
        chosen, run = self.run_dialog("D:\\CFD_tool\\Ü\n".encode("utf-8"))
        self.assertEqual(chosen, "D:\\CFD_tool\\Ü")
        args, kwargs = run.call_args
        command = args[0]
        self.assertEqual(command[:5], ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"])
        self.assertEqual(base64.b64decode(command[5]).decode("utf-16-le"), serve.FOLDER_DIALOG)
        self.assertNotIn("CFD tool", " ".join(command))
        self.assertEqual(kwargs["env"]["HOMO_DIALOG_START"], r"D:\CFD tool\Ü")
        self.assertEqual(kwargs["env"]["HOMO_DIALOG_TITLE"], "Choose Working Directory")

    def test_cancel_and_failure(self):
        self.assertIsNone(self.run_dialog(b"")[0])
        self.assertIsInstance(self.run_dialog(b"", code=1)[0], RuntimeError)

    def test_dialogs_without_tkinter(self):
        with mock.patch.object(serve, "tkinter_available", return_value=False):
            with mock.patch.object(serve, "powershell", return_value="powershell.exe"):
                self.assertTrue(serve.dialogs_available())
                with mock.patch.object(serve, "powershell_dialog", return_value="D:\\x") as dialog:
                    self.assertEqual(serve.browse_for_sim("D:\\"), "D:\\x")
                    self.assertIs(dialog.call_args[0][0], serve.SIM_DIALOG)
            with mock.patch.object(serve, "powershell", return_value=None):
                self.assertFalse(serve.dialogs_available())


if __name__ == "__main__":
    unittest.main()
