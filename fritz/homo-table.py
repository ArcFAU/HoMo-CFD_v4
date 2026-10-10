#!/usr/bin/env python3
"""HoMo CFD results table for the terminal, e.g. on a phone through Termius.

Run it on Fritz in the folder that holds your case folders (or pass --dir):

    python3 homo-table.py                    all cases, newest activity first
    python3 homo-table.py --sort downforce   most downforce first (also: drag, ld, name, time)
    python3 homo-table.py 1002_homo_test     one case in detail (all monitors)
    python3 homo-table.py --wide             forces in N and speed, also on a narrow screen

It reads the same files as HoMo CFD: the last row of plots/Coefficients*.csv
(CzA, CxA and the parts' monitors), the speed in Settings (Vehicle State/Velocity,
km/h) and the job files for the state. Downforce = 1/2 * rho * v^2 * (-CzA), drag
the same with CxA, at each case's own speed. It only reads; it never changes,
starts or deletes anything. Python 3.6 or newer, nothing else needed.
"""

import argparse
import csv
import glob
import os
import re
import shutil
import sys
import time

DENSITY = 1.18415  # kg/m^3, STAR-CCM+'s default air density (as HoMo CFD)
STALE_HOURS = 12  # an unfinished case without a new job log for this long has probably stopped
POST_FAILED = re.compile(r"^((java|star)\.[A-Za-z0-9_.]*(Exception|Error)|[A-Za-z0-9_]+\.java:[0-9]+: error:)", re.M)
STATES = {"prepared": "prep", "meshing": "mesh", "solving": "solve", "waiting-post": "wait",
          "post": "post", "ready": "done", "post-failed": "FAIL"}
# Monitors, as HoMo CFD names them, from the CSV headers.
PARTS = [("frontwing", "FW"), ("undertray", "UT"), ("rearwing", "RW"), ("mono", "MO"), ("remaining", "Rem")]


def monitor_name(header):
    """'CzA Frontwing Monitor: ...' -> 'CzA FW'; 'CzA Front (percentage) ...' -> 'CzA Front'."""
    lower = header.lower()
    for prefix in ("cza", "cxa"):
        if not lower.startswith(prefix):
            continue
        base = "CzA" if prefix == "cza" else "CxA"
        if prefix == "cza" and "front (percentage)" in lower:
            return "CzA Front"
        for word, short in PARTS:
            if word in lower:
                return base + " " + short
        return base
    return "Iteration" if lower == "iteration" else None


def number(text):
    try:
        value = float(str(text).strip())
    except ValueError:
        return None
    return value if value == value and abs(value) != float("inf") else None


def coefficients(case):
    """{monitor: value} from the last row of the newest plots/Coefficients*.csv, or {}."""
    files = sorted(glob.glob(os.path.join(case, "plots", "Coefficients*.csv")), key=os.path.getmtime)
    if not files:
        return {}
    try:
        with open(files[-1], newline="", encoding="utf-8", errors="replace") as handle:
            rows = [row for row in csv.reader(handle) if row]
    except OSError:
        return {}
    if len(rows) < 2:
        return {}
    values = {}
    for header, cell in zip(rows[0], rows[-1]):
        name, value = monitor_name(header), number(cell)
        if name and value is not None and name not in values:
            values[name] = value
    return values


def setting(case, key):
    try:
        with open(os.path.join(case, "Settings"), encoding="utf-8", errors="replace") as handle:
            for line in handle:
                name, _, value = line.partition(" : ")
                if name.strip() == key:
                    return value.strip()
    except OSError:
        pass
    return None


def newest(pattern):
    files = glob.glob(pattern)
    return max(files, key=os.path.getmtime) if files else None


def state(case):
    """Like HoMo CFD's Simulations on Fritz: (state, time of the newest job log or None)."""
    has = lambda name: os.path.exists(os.path.join(case, name))
    post_log = newest(os.path.join(case, "post.o*"))
    if post_log:
        try:
            with open(post_log, encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError:
            text = ""
        if POST_FAILED.search(text):
            current = "post-failed"
        elif "Job finished at" in text[-4000:] or has("plots/POST_DONE"):
            current = "ready"
        else:
            current = "post"
    elif has("plots/POST_DONE"):
        current = "ready"
    elif has("plots/DONE"):
        current = "waiting-post"
    elif has("STARTED"):
        current = "solving" if glob.glob(os.path.join(case, "resTAURANtS.o*")) else "meshing"
    else:
        current = "prepared"
    log = newest(os.path.join(case, "*.o*"))
    return current, (os.path.getmtime(log) if log else None)


def cases(folder):
    found = []
    for name in sorted(os.listdir(folder), key=str.lower):
        case = os.path.join(folder, name)
        if not os.path.isdir(case) or not any(os.path.exists(os.path.join(case, item)) for item in ("Settings", "STARTED", "plots")):
            continue
        current, last_log = state(case)
        values = coefficients(case)
        speed = number(setting(case, "Vehicle State/Velocity") or "")
        q = 0.5 * DENSITY * (speed / 3.6) ** 2 if speed else None
        cza, cxa = values.get("CzA"), values.get("CxA")
        found.append({
            "name": name, "state": current, "lastLog": last_log, "values": values, "speed": speed,
            "stale": current not in ("ready", "post-failed", "prepared") and last_log is not None and time.time() - last_log > STALE_HOURS * 3600,
            "downforce": -cza * q if cza is not None and q else None,
            "drag": -cxa * q if cxa is not None and q else None,
            "ld": cza / cxa if cza is not None and cxa else None,
        })
    return found


def fmt(value, decimals):
    return "-" if value is None else "{:.{}f}".format(value, decimals)


def ago(stamp):
    if not stamp:
        return "-"
    minutes = int((time.time() - stamp) // 60)
    if minutes < 60:
        return "{}m".format(minutes)
    if minutes < 48 * 60:
        return "{}h".format(minutes // 60)
    return "{}d".format(minutes // 1440)


def table(rows, wide):
    """Plain columns; the case name gets whatever width is left."""
    columns = [("State", 5, lambda r: STATES[r["state"]] + ("?" if r["stale"] else "")),
               ("CzA", 7, lambda r: fmt(r["values"].get("CzA"), 3)),
               ("CxA", 6, lambda r: fmt(r["values"].get("CxA"), 3)),
               ("L/D", 5, lambda r: fmt(r["ld"], 2))]
    if wide:
        columns += [("Fz[N]", 7, lambda r: fmt(r["downforce"], 1)),
                    ("Fx[N]", 6, lambda r: fmt(r["drag"], 1)),
                    ("km/h", 5, lambda r: fmt(r["speed"], 0)),
                    ("Log", 4, lambda r: ago(r["lastLog"]))]
    width = shutil.get_terminal_size((60, 20)).columns
    name_width = max(8, min(max([len(r["name"]) for r in rows] + [4]), width - sum(w + 1 for _, w, _ in columns)))
    lines = [" ".join(["Case".ljust(name_width)] + [title.rjust(w) for title, w, _ in columns])]
    for row in rows:
        name = row["name"] if len(row["name"]) <= name_width else row["name"][:name_width - 1] + "~"
        lines.append(" ".join([name.ljust(name_width)] + [get(row).rjust(w) for _, w, get in columns]))
    return "\n".join(lines)


def detail(row):
    values = row["values"]
    lines = ["{}  ({}{})".format(row["name"], row["state"], ", probably stopped" if row["stale"] else ""),
             "Iteration     {}".format(fmt(values.get("Iteration"), 0)),
             "Speed         {} km/h".format(fmt(row["speed"], 1)),
             "Downforce     {} N".format(fmt(row["downforce"], 1)),
             "Drag          {} N".format(fmt(row["drag"], 1)),
             "L/D           {}".format(fmt(row["ld"], 2)),
             "CzA Front     {}".format(fmt(values.get("CzA Front"), 3)),
             "",
             "Part       CzA      CxA"]
    for label in ["total"] + [short for _, short in PARTS]:
        key = "" if label == "total" else " " + label
        lines.append("{:<7} {:>8} {:>8}".format(label, fmt(values.get("CzA" + key), 3), fmt(values.get("CxA" + key), 3)))
    lines.append("")
    lines.append("Last job log  {} ago".format(ago(row["lastLog"])))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="HoMo CFD results table (read-only).")
    parser.add_argument("case", nargs="?", help="show one case in detail")
    parser.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)), help="folder with the case folders (default: this script's folder)")
    parser.add_argument("--sort", choices=["time", "name", "downforce", "drag", "ld"], default="time")
    parser.add_argument("--wide", action="store_true", help="add forces, speed and last log even on a narrow screen")
    args = parser.parse_args(argv)

    rows = cases(args.dir)
    if args.case:
        match = [row for row in rows if row["name"] == args.case] or [row for row in rows if args.case.lower() in row["name"].lower()]
        if not match:
            print("No case named {} in {}".format(args.case, args.dir))
            return 1
        print("\n\n".join(detail(row) for row in match))
        return 0
    if not rows:
        print("No case folders in {}".format(args.dir))
        return 1
    missing = lambda value: value is None
    keys = {"time": lambda r: -(r["lastLog"] or 0), "name": lambda r: r["name"].lower(),
            "downforce": lambda r: (missing(r["downforce"]), -(r["downforce"] or 0)),
            "drag": lambda r: (missing(r["drag"]), r["drag"] or 0),
            "ld": lambda r: (missing(r["ld"]), -(r["ld"] or 0))}
    rows.sort(key=keys[args.sort])
    wide = args.wide or shutil.get_terminal_size((60, 20)).columns >= 80
    print(table(rows, wide))
    if any(row["stale"] for row in rows):
        print("? no job log for {} h: probably stopped".format(STALE_HOURS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
