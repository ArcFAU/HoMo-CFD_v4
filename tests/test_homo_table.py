"""fritz/homo-table.py: the results table for the terminal on Fritz (e.g. Termius on a phone)."""

import contextlib
import importlib.util
import io
import os
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "fritz" / "homo-table.py"
spec = importlib.util.spec_from_file_location("homo_table", SCRIPT)
homo_table = importlib.util.module_from_spec(spec)
spec.loader.exec_module(homo_table)

HEADER = ('"Iteration","CzA Front (percentage) Monitor: CzA Front (percentage) Monitor","CzA Monitor: CzA Monitor",'
          '"CzA Frontwing Monitor: CzA Frontwing Monitor","CxA Monitor: CxA Monitor","CxA Frontwing Monitor: CxA Frontwing Monitor"')


def make_case(root, name, cza=None, cxa=-1.5, speed=40.0, files=(), post_log=None, age_hours=0):
    case = Path(root) / name
    (case / "plots").mkdir(parents=True)
    if speed is not None:
        (case / "Settings").write_text(f"Vehicle State/RH : 35.0\nVehicle State/Velocity : {speed}\n", encoding="utf-8")
    if cza is not None:
        (case / "plots" / "Coefficients_49.csv").write_text(
            HEADER + f"\n1.0,0.1,-1.0,-0.2,-0.5,-0.1\n1000.0,0.45,{cza},-1.25,{cxa},-0.3\n", encoding="utf-8")
    for item in files:
        (case / item).write_text("", encoding="utf-8")
    if post_log is not None:
        (case / "post.o123").write_text(post_log, encoding="utf-8")
    for log in case.glob("*.o*"):
        stamp = time.time() - age_hours * 3600
        os.utime(log, (stamp, stamp))
    return case


def run(*args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = homo_table.main(list(args))
    return code, out.getvalue()


class HomoTableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name

    def test_monitor_names_like_homo(self):
        self.assertEqual(homo_table.monitor_name("CzA Monitor: CzA Monitor"), "CzA")
        self.assertEqual(homo_table.monitor_name("CzA Frontwing Monitor: CzA Frontwing Monitor"), "CzA FW")
        self.assertEqual(homo_table.monitor_name("CxA Rearwing Monitor: x"), "CxA RW")
        self.assertEqual(homo_table.monitor_name("CzA Front (percentage) Monitor: x"), "CzA Front")
        self.assertEqual(homo_table.monitor_name("Iteration"), "Iteration")
        self.assertIsNone(homo_table.monitor_name("Residual"))

    def test_states_like_simulations_on_fritz(self):
        make_case(self.root, "prep", files=())
        make_case(self.root, "meshing", files=("STARTED", "mesh.o1"))
        make_case(self.root, "solving", files=("STARTED", "mesh.o1", "resTAURANtS.o2"))
        make_case(self.root, "waiting", files=("STARTED", "plots/DONE"))
        make_case(self.root, "post", cza=-3.0, files=("plots/DONE",), post_log="running\n")
        make_case(self.root, "done", cza=-3.0, files=("plots/DONE",), post_log="...\nJob finished at Fri Oct  9\n")
        make_case(self.root, "failed", cza=-3.0, post_log="java.lang.RuntimeException: Settings\nJob finished at Fri\n")
        states = {row["name"]: row["state"] for row in homo_table.cases(self.root)}
        self.assertEqual(states, {"prep": "prepared", "meshing": "meshing", "solving": "solving", "waiting": "waiting-post",
                                  "post": "post", "done": "ready", "failed": "post-failed"})

    def test_forces_at_each_cases_own_speed(self):
        make_case(self.root, "slow", cza=-3.2, cxa=-1.25, speed=40.0, post_log="Job finished at x\n")
        make_case(self.root, "fast", cza=-3.2, cxa=-1.25, speed=60.0, post_log="Job finished at x\n")
        make_case(self.root, "nospeed", cza=-3.2, speed=None, post_log="Job finished at x\n")
        rows = {row["name"]: row for row in homo_table.cases(self.root)}
        q40 = 0.5 * 1.18415 * (40 / 3.6) ** 2
        self.assertAlmostEqual(rows["slow"]["downforce"], 3.2 * q40)
        self.assertAlmostEqual(rows["slow"]["drag"], 1.25 * q40)
        self.assertAlmostEqual(rows["fast"]["downforce"], 3.2 * q40 * 2.25)
        self.assertAlmostEqual(rows["slow"]["ld"], 3.2 / 1.25)
        self.assertIsNone(rows["nospeed"]["downforce"])
        self.assertEqual(rows["slow"]["values"]["CzA FW"], -1.25)

    def test_stale_only_for_unfinished_cases(self):
        make_case(self.root, "stopped", files=("STARTED", "resTAURANtS.o2"), age_hours=20)
        make_case(self.root, "old-done", cza=-3.0, post_log="Job finished at x\n", age_hours=200)
        rows = {row["name"]: row for row in homo_table.cases(self.root)}
        self.assertTrue(rows["stopped"]["stale"])
        self.assertFalse(rows["old-done"]["stale"])
        code, out = run("--dir", self.root)
        self.assertIn("solve?", out)
        self.assertIn("probably stopped", out)

    def test_table_fits_a_phone_and_sorts(self):
        make_case(self.root, "a_little_downforce_with_a_very_long_case_name", cza=-2.0, post_log="Job finished at x\n")
        make_case(self.root, "b_most", cza=-5.0, post_log="Job finished at x\n")
        os.environ["COLUMNS"] = "45"
        try:
            code, out = run("--dir", self.root, "--sort", "downforce")
        finally:
            del os.environ["COLUMNS"]
        lines = out.splitlines()
        self.assertEqual(code, 0)
        self.assertTrue(all(len(line) <= 45 for line in lines), lines)
        self.assertTrue(lines[1].startswith("b_most"), lines)
        self.assertIn("~", lines[2])  # long names are cut
        self.assertNotIn("Fz[N]", lines[0])
        code, out = run("--dir", self.root, "--wide")
        self.assertIn("Fz[N]", out.splitlines()[0])

    def test_one_case_in_detail(self):
        make_case(self.root, "1002_homo_test", cza=-5.755, cxa=-1.922, post_log="Job finished at x\n")
        code, out = run("--dir", self.root, "1002")
        self.assertEqual(code, 0)
        self.assertIn("1002_homo_test  (ready)", out)
        self.assertIn("Iteration     1000", out)
        self.assertRegex(out, r"FW\s+-1\.250\s+-0\.300")
        code, out = run("--dir", self.root, "nothing")
        self.assertEqual(code, 1)
        self.assertIn("No case named nothing", out)

    def test_never_writes(self):
        make_case(self.root, "done", cza=-3.0, post_log="Job finished at x\n")
        before = sorted((str(p), p.stat().st_mtime) for p in Path(self.root).rglob("*"))
        run("--dir", self.root)
        run("--dir", self.root, "done")
        self.assertEqual(before, sorted((str(p), p.stat().st_mtime) for p in Path(self.root).rglob("*")))

    def test_runs_on_python_36(self):
        import ast
        ast.parse(SCRIPT.read_text(encoding="utf-8"), feature_version=(3, 6))


if __name__ == "__main__":
    unittest.main()
