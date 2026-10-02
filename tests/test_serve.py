"""Unit tests for serve.py (no browser needed).

    py -m unittest discover -s tests -v      (from the project folder)

Every test uses a temporary APPDATA, so real HoMo CFD / CFD-Tool settings
are never read or written.
"""

import http.client
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import fixture  # noqa: E402
from test_cluster import FakeWinScp  # noqa: E402

spec = importlib.util.spec_from_file_location("serve", HERE.parent / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ServeTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="homo-cfd-serve-"))
        self.saved_appdata = os.environ.get("APPDATA")
        os.environ["APPDATA"] = str(self.temp / "appdata")
        self.working_dir = fixture.build(self.temp)

    def tearDown(self):
        if self.saved_appdata is None:
            os.environ.pop("APPDATA", None)
        else:
            os.environ["APPDATA"] = self.saved_appdata
        shutil.rmtree(self.temp, ignore_errors=True)

    def write_cfd_tool_setting(self, value):
        folder = self.temp / "appdata" / "CFD-Tool" / "resources"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "workingDir").write_text(value + "\n", encoding="utf-8")


class WorkingDirectoryTests(ServeTestCase):
    def test_nothing_configured(self):
        self.assertEqual(serve.find_working_dir(None), (None, None))

    def test_cfd_tool_setting_is_used(self):
        self.write_cfd_tool_setting(str(self.working_dir))
        path, source = serve.find_working_dir(None)
        self.assertEqual((path, source), (self.working_dir.absolute(), "CFD-Tool"))
        self.assertEqual(serve.results_folder(path), self.working_dir.absolute() / "finished")

    def test_homo_setting_beats_cfd_tool(self):
        self.write_cfd_tool_setting(str(self.working_dir))
        other = self.working_dir / "finished" / "caseA"
        serve.write_settings({"workingDir": str(other)})
        self.assertEqual(serve.find_working_dir(None), (other.absolute(), "HoMo CFD settings"))

    def test_command_line_beats_saved_settings(self):
        serve.write_settings({"workingDir": str(self.working_dir)})
        other = self.working_dir / "finished"
        self.assertEqual(serve.find_working_dir(str(other)), (other.absolute(), "command line"))

    def test_missing_command_line_folder_stops(self):
        with self.assertRaises(SystemExit):
            serve.find_working_dir(str(self.temp / "missing"))

    def test_stale_saved_setting_falls_through(self):
        serve.write_settings({"workingDir": str(self.temp / "moved-away")})
        self.write_cfd_tool_setting(str(self.working_dir))
        self.assertEqual(serve.find_working_dir(None)[1], "CFD-Tool")

    def test_folder_without_finished_is_the_results_folder(self):
        case = self.working_dir / "finished" / "caseA"
        self.assertEqual(serve.results_folder(case), case)


class ApiTests(ServeTestCase):
    def setUp(self):
        super().setUp()
        serve.Handler.working_dir.set(self.working_dir, "test")
        quiet = type("QuietHandler", (serve.Handler,), {"log_message": lambda *args: None})
        self.server = serve.Server(("127.0.0.1", 0), quiet)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        serve.Handler.working_dir.set(None, None)
        super().tearDown()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, data

    def test_config_reports_finished_folder(self):
        status, data = self.request("GET", "/api/config")
        config = json.loads(data)
        self.assertEqual(status, 200)
        self.assertEqual(config["resultsRoot"], "finished")
        self.assertEqual(config["source"], "test")

    def test_list_and_tree(self):
        status, data = self.request("GET", "/api/list?path=")
        self.assertEqual((status, [entry["name"] for entry in json.loads(data)]), (200, ["caseA", "caseB"]))
        status, data = self.request("GET", "/api/tree?path=caseA")
        tree = json.loads(data)
        self.assertIn("Cp_x-Section", tree["d"])
        self.assertEqual(len(tree["d"]["Cp_x-Section"]["f"]), 12)

    def test_file_and_conditional_get(self):
        status, data = self.request("GET", "/api/file?path=caseA/plots/Coefficients_49.csv")
        self.assertEqual(status, 200)
        self.assertTrue(data.startswith(b'"Iteration"'))
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("GET", "/api/file?path=caseA/plots/Coefficients_49.csv")
        modified = connection.getresponse().getheader("Last-Modified")
        connection.close()
        status, _ = self.request("GET", "/api/file?path=caseA/plots/Coefficients_49.csv", headers={"If-Modified-Since": modified})
        self.assertEqual(status, 304)

    def test_paths_outside_results_are_rejected(self):
        for path in ("../serve.py", "caseA/../../serve.py", "..%2Fserve.py", "%2E%2E/serve.py",
                     "C:/Windows/win.ini", "caseA\\..\\..\\serve.py", ".git", "caseA/.hidden"):
            with self.subTest(path=path):
                status, _ = self.request("GET", f"/api/file?path={path}")
                self.assertEqual(status, 400)

    def test_foreign_host_is_rejected(self):
        status, _ = self.request("GET", "/api/list?path=", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("GET", "/api/config", headers={"Host": f"localhost:{self.port}"})
        self.assertEqual(status, 200)

    def test_set_working_dir(self):
        other = self.working_dir / "finished"
        body = json.dumps({"path": str(other)})
        status, data = self.request("POST", "/api/working-dir", body, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["workingDir"], str(other.absolute()))
        self.assertEqual(serve.read_settings()["workingDir"], str(other.absolute()))

    def test_set_working_dir_validation(self):
        cases = [
            (json.dumps({"path": str(self.temp / "missing")}), {"Content-Type": "application/json"}, 400),
            (json.dumps({"path": "relative/folder"}), {"Content-Type": "application/json"}, 400),
            ("path=C:/", {"Content-Type": "application/x-www-form-urlencoded"}, 415),
            ("not json", {"Content-Type": "application/json"}, 400),
        ]
        for body, headers, expected in cases:
            with self.subTest(body=body):
                status, _ = self.request("POST", "/api/working-dir", body, headers)
                self.assertEqual(status, expected)
        self.assertNotIn("workingDir", serve.read_settings())

    def test_app_page_is_served(self):
        status, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"server-fs.js", data)



class ClusterApiTests(ApiTests):
    """/api/cluster with a fake WinSCP: the real sessions and Fritz are never used."""

    def setUp(self):
        super().setUp()
        self.saved_winscp = serve.Handler.winscp
        self.fake = FakeWinScp(0, "Session started.\n/home/vault/g/u/Pipeline\n", sessions=["Fritz", "Other"])
        serve.Handler.winscp = self.fake

    def tearDown(self):
        serve.Handler.winscp = self.saved_winscp
        super().tearDown()

    def post(self, path, value, content_type="application/json"):
        status, data = self.request("POST", path, json.dumps(value), {"Content-Type": content_type})
        return status, json.loads(data) if data.startswith(b"{") else data

    def test_settings_start_empty(self):
        status, data = self.request("GET", "/api/cluster")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"winscp": str(Path("C:/fake/WinSCP.com")), "sessions": ["Fritz", "Other"],
                                            "session": "", "remoteFolder": ""})

    def test_save_keeps_working_dir(self):
        serve.write_settings({"workingDir": str(self.working_dir)})
        status, data = self.post("/api/cluster", {"session": "Fritz", "remoteFolder": "/home/vault/g/u/Pipeline"})
        self.assertEqual((status, data["session"], data["remoteFolder"]), (200, "Fritz", "/home/vault/g/u/Pipeline"))
        saved = serve.read_settings()
        self.assertEqual(saved["cluster"], {"session": "Fritz", "remoteFolder": "/home/vault/g/u/Pipeline"})
        self.assertEqual(saved["workingDir"], str(self.working_dir))

    def test_invalid_input_is_rejected(self):
        for body in ({"session": ""}, {"session": 'a"b'}, {"session": "Fritz", "remoteFolder": "Pipeline"}):
            with self.subTest(body=body):
                self.assertEqual(self.post("/api/cluster", body)[0], 400)
                self.assertEqual(self.post("/api/cluster/test", body)[0], 400)
        self.assertEqual(self.post("/api/cluster/test", {"session": "Fritz"}, "text/plain")[0], 415)
        self.assertEqual(self.fake.scripts, [])
        self.assertNotIn("cluster", serve.read_settings())

    def test_connection_test(self):
        status, data = self.post("/api/cluster/test", {"session": "Fritz", "remoteFolder": "/home/vault/g/u/Pipeline"})
        self.assertEqual((status, data["ok"], data["remoteFolder"]), (200, True, "/home/vault/g/u/Pipeline"))
        self.assertIn('open "Fritz"', self.fake.scripts[0])
        self.assertNotIn("cluster", serve.read_settings(), "testing does not save")

    def test_without_winscp(self):
        self.fake.installed = False
        status, data = self.post("/api/cluster/test", {"session": "Fritz"})
        self.assertEqual((status, data["ok"]), (200, False))
        self.assertIn("not installed", data["error"])
        self.assertEqual(self.fake.scripts, [])

    def test_foreign_host_is_rejected(self):
        status, _ = self.request("GET", "/api/cluster", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
