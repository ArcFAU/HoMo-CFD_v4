"""Unit tests for cluster.py (WinSCP access to Fritz). No cluster, no real WinSCP.

    py -m unittest discover -s tests -v      (from the project folder)
"""

import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import cluster  # noqa: E402


# What the status command prints on Fritz (see cluster.case_status_command).
NOW = int(time.time())
STATUS_OUTPUT = "\n".join([
    "Session started.",
    f"HOMO|caseA|SDMTRP|{NOW - 3000}",   # also in the fixture's finished/
    f"HOMO|caseC|SDMTRP|{NOW - 2000}",   # ready to download
    f"HOMO|caseD|SMT|{NOW - 600}",       # solving
    "HOMO|caseE|SDMTR|1600000000",      # post-processing, but long silent
    "HOMO|bad/name|SDMTRP|1",           # not usable as a folder name
])


class FakeProcess:
    def __init__(self, fake):
        self.fake = fake

    def poll(self):
        return None

    def terminate(self):
        self.fake.release.set()


class FakeWinScp(cluster.WinScp):
    """Records scripts instead of running WinSCP; "downloads" write one file."""

    def __init__(self, code=0, output="", sessions=("Fritz",), installed=True, key_files=None):
        self.code, self.output, self.session_names, self.installed = code, output, list(sessions), installed
        self.key_files = {"Fritz": Path("C:/keys/fritz.ppk")} if key_files is None else key_files
        self.scripts = []
        self.pageant_keys = []
        self.status_output = STATUS_OUTPUT
        self.stream_code = 0
        self.hold = False                 # keep a download "running" until cancelled
        self.release = threading.Event()

    def executable(self):
        return Path("C:/fake/WinSCP.com") if self.installed else None

    def sessions(self):
        return self.session_names

    def registry_sessions(self):
        return {name: name for name in self.session_names}

    def session_key_file(self, session):
        return self.key_files.get(session)

    def pageant(self):
        return Path("C:/fake/pageant.exe") if self.installed else None

    def pageant_running(self):
        return bool(self.pageant_keys)

    def start_pageant(self, key_file):
        self.pageant_keys.append(key_file)

    def run(self, lines):
        self.scripts.append(lines)
        if any(line.startswith("call for d in") for line in lines):
            return self.code, self.status_output
        return self.code, self.output

    def stream(self, lines, on_line, on_start=lambda process: None):
        self.scripts.append(lines)
        on_start(FakeProcess(self))
        local = re.search(r'synchronize local -filemask="[^"]*" "([^"]+)"', "\n".join(lines)).group(1)
        on_line(f"{cluster.TOTAL_PREFIX}2|300")
        (Path(local) / "plots").mkdir(parents=True, exist_ok=True)
        (Path(local) / "plots" / "Coefficients_49.csv").write_text("Iteration\n1\n", encoding="utf-8")
        on_line("Coefficients_49.csv       |         261 KB | 4875.3 KB/s | binary | 100%")
        if self.hold:
            self.release.wait(10)
            return 1
        on_line("DONE                      |            0 B | 2463.9 KB/s | binary |   0%")
        return self.stream_code


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
            "Authenticating with public key \"rsa-key\".\nPassphrase for key 'rsa-key': Credentials were not specified.\n"
            "Authentication failed.": "Unlock key with Pageant",
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
                self.assertEqual(result["needsPassphrase"], "Passphrase" in output)


class StatusTests(unittest.TestCase):
    def test_states_from_flags(self):
        expected = {"": "prepared", "S": "meshing", "SM": "meshing", "SMT": "solving", "SDMT": "waiting-post",
                    "SDMTR": "post", "SDMTRP": "ready", "SDMTRX": "ready", "DMTRP": "ready"}
        for flags, state in expected.items():
            with self.subTest(flags=flags):
                self.assertEqual(cluster.case_state(flags), state)

    def test_parse_cases(self):
        cases = cluster.parse_cases("noise\n" + STATUS_OUTPUT + "\nHOMO|broken", now=NOW)
        self.assertEqual([case["name"] for case in cases], ["caseD", "caseC", "caseA", "caseE", "bad/name"])
        by_name = {case["name"]: case for case in cases}
        self.assertEqual((by_name["caseC"]["state"], by_name["caseC"]["stale"]), ("ready", False))
        self.assertEqual((by_name["caseD"]["state"], by_name["caseD"]["stale"]), ("solving", False))
        self.assertEqual((by_name["caseE"]["state"], by_name["caseE"]["stale"]), ("post", True))

    def test_status_script_is_read_only(self):
        lines = cluster.status_script("Fritz", "/home/vault/g/u")
        command = lines[-2]
        self.assertTrue(command.startswith("call for d in */"))
        without_redirects = re.sub(r"\d?>(/dev/null|&1)", "", command)
        for word in ("rm ", "mv ", "sbatch", "scancel", ">", "touch"):
            self.assertNotIn(word, without_redirects)

    def test_case_names(self):
        self.assertEqual(cluster.check_case_name("0830_mk2.2"), "0830_mk2.2")
        for bad in ("", ".", "..", ".hidden", "a/b", "a\\b", "C:x", 'a"b', "a|b", None):
            with self.subTest(name=bad), self.assertRaises(ValueError):
                cluster.check_case_name(bad)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="homo-cfd-download-"))
        self.partial, self.finished = self.temp / "inProgress" / "caseC", self.temp / "finished" / "caseC"
        self.finished.parent.mkdir()

    def tearDown(self):
        shutil.rmtree(self.temp, ignore_errors=True)

    def lines(self, include_sim=False):
        return cluster.download_script("Fritz", "/home/vault/g/u", "caseC", str(self.partial), include_sim)

    def test_script_skips_scripts_and_never_deletes(self):
        lines = self.lines()
        sync = next(line for line in lines if line.startswith("synchronize"))
        self.assertTrue(sync.startswith("synchronize local "))
        self.assertIn('-filemask="|*.sim~; *.sh; *.java; ABORT*; *.sim"', sync)
        self.assertNotIn("-delete", sync)
        self.assertIn('! -name "*.sim"', lines[3])
        self.assertNotIn("*.sim\"", next(line for line in self.lines(True) if line.startswith("synchronize")).replace("*.sim~", ""))
        for line in lines:
            self.assertFalse(line.split()[0] in ("rm", "rmdir", "mv", "put", "chmod"), line)

    def test_progress_and_move_to_finished(self):
        download = cluster.Download("caseC")
        cluster.run_download(FakeWinScp(), download, self.lines(), self.partial, self.finished)
        self.assertEqual(download.describe()["state"], "done", download.message)
        self.assertEqual((download.files_done, download.files_total, download.bytes_total), (2, 2, 300))
        self.assertTrue((self.finished / "plots" / "Coefficients_49.csv").is_file())
        self.assertFalse(self.partial.exists())

    def test_failure_keeps_partial_download(self):
        fake = FakeWinScp()
        fake.stream_code = 1
        download = cluster.Download("caseC")
        cluster.run_download(fake, download, self.lines(), self.partial, self.finished)
        self.assertEqual(download.state, "failed")
        self.assertTrue(self.partial.exists())
        self.assertFalse(self.finished.exists())

    def test_cancel(self):
        fake = FakeWinScp()
        fake.hold = True
        download = cluster.Download("caseC")
        worker = threading.Thread(target=cluster.run_download, args=(fake, download, self.lines(), self.partial, self.finished))
        worker.start()
        while download.process is None:
            worker.join(0.01)
        download.cancel()
        worker.join(10)
        self.assertEqual(download.state, "cancelled")
        self.assertIn("resumes", download.message)
        self.assertTrue(self.partial.exists())

    def test_existing_finished_folder_is_not_overwritten(self):
        (self.finished / "keep").mkdir(parents=True)
        download = cluster.Download("caseC")
        cluster.run_download(FakeWinScp(), download, self.lines(), self.partial, self.finished)
        self.assertEqual(download.state, "failed")
        self.assertTrue((self.finished / "keep").is_dir())


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
