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
from urllib.parse import unquote
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
    "HOMO|caseF||0",                    # created, not started
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
        self.existing = {"SCRIPT_FABSI", "caseA"}   # folders on the fake Fritz
        self.uploads = []
        self.refuse = False               # the jump host turns the login away
        self.hosts = {}
        self.jobs_output = f"{cluster.JOB_PREFIX}4100|resTAURANtS|RUNNING|1:02:03|/home/vault/g/u/caseD"
        self.settings_text = "Vehicle State/Velocity : 40.0\nRun Settings/Mesh Nodes : 2\n"

    def executable(self):
        return Path("C:/fake/WinSCP.com") if self.installed else None

    def sessions(self):
        return self.session_names

    def registry_sessions(self):
        return {name: name for name in self.session_names}

    def session_hosts(self):
        return {name: host for name, host in self.hosts.items() if name in self.session_names}

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
        script = "\n".join(lines)
        if "call for d in" in script:
            return self.code, self.status_output
        if "call squeue" in script:
            return self.code, self.jobs_output
        if "sbatch --version" in script:
            return self.code, "Session started.\nslurm 25.11.8"
        if "&& sbatch mesh.sh" in script:
            return self.code, "Session started.\nSubmitted batch job 4242"
        fetch = re.search(r'^get "[^"]+" "([^"]+)"', script, re.M)
        if fetch:
            Path(fetch.group(1)).write_text(self.settings_text, encoding="utf-8")
            return 0, ""
        return self.code, self.output

    def stream(self, lines, on_line, on_start=lambda process: None):
        self.scripts.append(lines)
        on_start(FakeProcess(self))
        if any(line.startswith("mkdir ") for line in lines):
            return self.new_case(lines, on_line)
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

    def new_case(self, lines, on_line):
        """The new-case script, run like WinSCP: the first failing command stops it."""
        script = "\n".join(lines)
        if self.refuse:
            on_line('Network error: Connection to "fritz" refused.')
            return 1
        template, template_dir = re.search(r'^get -filemask="[^"]*" "([^"]+)/\*" "([^"]+)\\"$', script, re.M).groups()
        if template not in self.existing:
            on_line(f"Can't get attributes of file '{template}'.")
            on_line("No such file or directory.")
            return 1
        for name in ("mesh.sh", "Settings"):
            (Path(template_dir) / name).write_text(f"template {name}\n", encoding="utf-8")
        on_line(cluster.TEMPLATE_FETCHED)
        case = re.search(r'^mkdir "([^"]+)"$', script, re.M).group(1)
        if case in self.existing:
            on_line(f"Error creating folder '{case}'.")
            return 1
        self.existing.add(case)
        on_line(cluster.FOLDER_CREATED)
        if self.stream_code:
            on_line("Network error: Software caused connection abort.")
            return self.stream_code
        uploaded = []
        for line in lines:
            match = re.match(r'put (?:-filemask="\|([^"]*)" )?"([^"]+)" "([^"]+)"$', line)
            if not match:
                continue
            excluded, source, target = match.groups()
            if source.endswith("\\*"):
                uploaded.append((sorted(path.name for path in Path(source[:-2]).iterdir() if path.name != excluded), target))
            elif target.endswith("/Settings"):
                uploaded.append((Path(source).read_text(encoding="utf-8"), target))
            else:
                uploaded.append((source, target))
        self.uploads.append(uploaded)
        on_line(cluster.CASE_UPLOADED)
        return 0


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
        self.assertEqual(lines, ["option batch abort", "option confirm off", cluster.open_command("Fritz"),
                                 'cd "/home/vault/g/u/Pipeline"', "pwd", "exit"])
        words = " ".join(lines).split()
        for command in ("put", "get", "rm", "rmdir", "mv", "call", "synchronize", "chmod"):
            self.assertNotIn(command, words)

    def test_login_never_depends_on_the_sessions_local_folder(self):
        line = cluster.open_command("Fritz")
        self.assertTrue(line.startswith('open "Fritz" -rawsettings LocalDirectory="'))
        local = line.split('LocalDirectory="', 1)[1].rstrip('"')
        self.assertTrue(Path(unquote(local)).is_dir(), local)
        self.assertNotIn(" ", local, "encoded like WinSCP's own settings")

    def test_without_folder_skips_cd(self):
        self.assertNotIn("cd", " ".join(cluster.test_script("Fritz")).split())

    def test_connection_success_reports_folder(self):
        fake = FakeWinScp(0, "Searching for host...\nAuthenticated.\nSession started.\n/home/vault/g/u/Pipeline\n")
        result = cluster.test_connection(fake, "Fritz", "/home/vault/g/u/Pipeline")
        self.assertEqual((result["ok"], result["remoteFolder"]), (True, "/home/vault/g/u/Pipeline"))
        self.assertEqual(fake.scripts[0][2], cluster.open_command("Fritz"))

    def test_connection_failure_gives_hint(self):
        cases = {
            "Authenticating with public key \"rsa-key\".\nPassphrase for key 'rsa-key': Credentials were not specified.\n"
            "Authentication failed.": "Unlock key with Pageant",
            "The server's host key was not found in the cache.": "host key",
            "Authentication failed.": "refused the login",
            'Error changing directory to "/nope".': "remote folder",
            'Host "Fritz" does not exist.': "no saved session",
            "Network error: Connection timed out.": "network",
            'Network error: Connection to "csnhr" refused.': "Wait a minute",
            "!!! ERROR !!! There is no 'sbatch' command on 'csnhr' by design!": "fritz.nhr.fau.de",
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
        self.assertEqual([case["name"] for case in cases], ["caseD", "caseC", "caseA", "caseE", "bad/name", "caseF"])
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


class NewCaseTests(unittest.TestCase):
    def test_settings_round_trip(self):
        text = "Vehicle State/Velocity : 40.0\nMesh/Base Size : 4\nnot a setting\n"
        pairs = cluster.parse_settings(text)
        self.assertEqual(pairs, [("Vehicle State/Velocity", "40.0"), ("Mesh/Base Size", "4")])
        self.assertEqual(cluster.format_settings(cluster.check_settings([list(pair) for pair in pairs])),
                         "Vehicle State/Velocity : 40.0\nMesh/Base Size : 4\n")
        for bad in ([], [["", "1"]], [["a", "x\ny"]], [["a : b", "1"]], [["a", 1]], "text"):
            with self.subTest(settings=bad), self.assertRaises(ValueError):
                cluster.check_settings(bad)

    def test_create_never_overwrites(self):
        lines = cluster.new_case_script("Fritz", "/home/vault/g/u", "SCRIPT_FABSI", "new1", "C:\\t\\tpl", "C:\\t\\s", "D:\\base.sim")
        self.assertEqual(lines[:4], ["option batch abort", "option confirm off", cluster.open_command("Fritz"), 'cd "/home/vault/g/u"'])
        commands = [line.split()[0] for line in lines[4:]]
        self.assertEqual(commands, ["get", "echo", "mkdir", "echo", "put", "put", "put", "echo", "exit"])
        self.assertNotIn("call", commands, "no shell command: it needs a second login and does not stop on errors")
        self.assertEqual(lines[4], 'get -filemask="|*.sim; *.sim~" "SCRIPT_FABSI/*" "C:\\t\\tpl\\"')
        self.assertEqual(lines[6], 'mkdir "new1"', "mkdir (fails if new1 exists) comes before any upload")
        self.assertEqual(lines[8:11], ['put -filemask="|Settings" "C:\\t\\tpl\\*" "new1/"',
                                       'put "C:\\t\\s" "new1/Settings"', 'put "D:\\base.sim" "new1/"'])

    def run_new_case(self, fake, name, template="SCRIPT_FABSI"):
        handle, temp_name = tempfile.mkstemp(prefix="homo-cfd-settings-test-")
        os.close(handle)
        settings_file = Path(temp_name)
        settings_file.write_text("Vehicle State/Velocity : 60.0\n", encoding="utf-8")
        task = cluster.Download(name)
        cluster.run_new_case(fake, task, "Fritz", "/home/vault/g/u", template, name, str(settings_file), "D:/base.sim")
        self.assertFalse(settings_file.exists(), "temporary Settings removed")
        template_dir = re.search(r'"([^"]+)\\"$', fake.scripts[-1][4]).group(1)
        self.assertFalse(Path(template_dir).exists(), "temporary template copy removed")
        return task

    def test_new_case_created_then_uploaded(self):
        fake = FakeWinScp()
        task = self.run_new_case(fake, "new1")
        self.assertEqual(task.state, "done", task.message)
        self.assertEqual(fake.uploads, [[(["mesh.sh"], "new1/"), ("Vehicle State/Velocity : 60.0\n", "new1/Settings"),
                                         ("D:/base.sim", "new1/")]])
        self.assertEqual(len(fake.scripts), 1, "one WinSCP run (one login)")

    def test_existing_folder_is_not_touched(self):
        fake = FakeWinScp()
        task = self.run_new_case(fake, "caseA")
        self.assertEqual(task.state, "failed")
        self.assertIn("probably exists already", task.message)
        self.assertIn("Nothing was changed", task.message)
        self.assertEqual(fake.uploads, [], "nothing uploaded into an existing folder")

    def test_missing_template_changes_nothing(self):
        fake = FakeWinScp()
        task = self.run_new_case(fake, "new1", template="SCRIPT_GONE")
        self.assertEqual(task.state, "failed")
        self.assertIn("The template folder SCRIPT_GONE was not found", task.message)
        self.assertNotIn("new1", fake.existing)
        self.assertEqual(fake.uploads, [])

    def test_refused_login_says_wait_and_retry(self):
        fake = FakeWinScp()
        fake.refuse = True
        task = self.run_new_case(fake, "new1")
        self.assertEqual(task.state, "failed")
        self.assertIn("Nothing was changed", task.message)
        self.assertIn("Wait a minute", task.message)
        self.assertNotIn("new1", fake.existing)

    def test_interrupted_upload_says_incomplete(self):
        fake = FakeWinScp()
        fake.stream_code = 1
        task = self.run_new_case(fake, "new1")
        self.assertEqual(task.state, "failed")
        self.assertIn("exists on Fritz but is incomplete; do not start it", task.message)

    def test_jobs_and_submit_parsing(self):
        jobs = cluster.parse_jobs("noise\n" + FakeWinScp().jobs_output)
        self.assertEqual(jobs, {"caseD": [{"id": "4100", "name": "resTAURANtS", "state": "RUNNING", "elapsed": "1:02:03"}]})
        self.assertEqual(cluster.SUBMITTED.search("Submitted batch job 4242").group(1), "4242")
        self.assertIn('call cd "/home/vault/g/u/new1" && sbatch mesh.sh', cluster.submit_script("Fritz", "/home/vault/g/u", "new1"))


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
