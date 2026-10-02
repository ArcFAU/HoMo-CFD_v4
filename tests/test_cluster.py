"""Unit tests for cluster.py (WinSCP access to Fritz). No cluster, no real WinSCP.

    py -m unittest discover -s tests -v      (from the project folder)
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import cluster  # noqa: E402


class FakeWinScp(cluster.WinScp):
    """Records the script instead of running WinSCP."""

    def __init__(self, code=0, output="", sessions=("Fritz",), installed=True):
        self.code, self.output, self.session_names, self.installed = code, output, list(sessions), installed
        self.scripts = []

    def executable(self):
        return Path("C:/fake/WinSCP.com") if self.installed else None

    def sessions(self):
        return self.session_names

    def run(self, lines):
        self.scripts.append(lines)
        return self.code, self.output


class InputTests(unittest.TestCase):
    def test_session_names(self):
        self.assertEqual(cluster.check_session("  Fritz/my session "), "Fritz/my session")
        for bad in ("", "   ", None, 5, 'a"b', "a\nb", "x" * 201):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                cluster.check_session(bad)

    def test_remote_folders(self):
        self.assertEqual(cluster.check_remote_folder(""), "")
        self.assertEqual(cluster.check_remote_folder(None), "")
        self.assertEqual(cluster.check_remote_folder(" /home/vault/g/u/Pipeline "), "/home/vault/g/u/Pipeline")
        self.assertEqual(cluster.check_remote_folder("~/Pipeline"), "~/Pipeline")
        for bad in ("Pipeline", "C:\\temp", '/a"b', "/a\nrm -rf /", 7, "/" + "x" * 500):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                cluster.check_remote_folder(bad)


class ScriptTests(unittest.TestCase):
    def test_test_script_is_read_only(self):
        lines = cluster.test_script("Fritz", "/home/vault/g/u/Pipeline")
        self.assertEqual(lines, ["option batch abort", "option confirm off", 'open "Fritz"',
                                 'cd "/home/vault/g/u/Pipeline"', "pwd", "exit"])
        words = " ".join(lines).split()
        for command in ("put", "get", "rm", "rmdir", "mv", "call", "synchronize", "chmod"):
            self.assertNotIn(command, words)

    def test_without_folder_skips_cd(self):
        self.assertNotIn("cd", " ".join(cluster.test_script("Fritz")).split())

    def test_connection_success_reports_folder(self):
        fake = FakeWinScp(0, "Searching for host...\nAuthenticated.\nSession started.\n/home/vault/g/u/Pipeline\n")
        result = cluster.test_connection(fake, "Fritz", "/home/vault/g/u/Pipeline")
        self.assertEqual((result["ok"], result["remoteFolder"]), (True, "/home/vault/g/u/Pipeline"))
        self.assertEqual(fake.scripts[0][2], 'open "Fritz"')

    def test_connection_failure_gives_hint(self):
        cases = {
            "The server's host key was not found in the cache.": "host key",
            "Authentication failed.": "refused the login",
            'Error changing directory to "/nope".': "remote folder",
            'Host "Fritz" does not exist.': "no saved session",
            "Network error: Connection timed out.": "network",
        }
        for output, expected in cases.items():
            with self.subTest(output=output):
                result = cluster.test_connection(FakeWinScp(1, output), "Fritz")
                self.assertFalse(result["ok"])
                self.assertIn(expected, result["hint"])


@unittest.skipUnless(os.name == "nt", "runs a .cmd file")
class RunTests(unittest.TestCase):
    def test_run_passes_a_script_file_and_cleans_up(self):
        folder = Path(tempfile.mkdtemp(prefix="homo-cfd-winscp-test-"))
        fake = folder / "WinSCP.cmd"
        fake.write_text("@echo off\r\necho %*\r\nexit /b 3\r\n", encoding="ascii")

        class Local(cluster.WinScp):
            def executable(self):
                return fake

        code, output = Local().run(["pwd", "exit"])
        self.assertEqual(code, 3)
        self.assertIn("/nointeractiveinput", output)
        script = output.split("/script=", 1)[1].strip().splitlines()[0].strip('"')
        self.assertFalse(Path(script).exists(), "temporary script removed")


if __name__ == "__main__":
    unittest.main()
