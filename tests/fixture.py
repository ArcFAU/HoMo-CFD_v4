"""Generate a small synthetic CFD-Tool working directory for the tests.

Real results are large and git-ignored, so the tests build their own data:

    <root>/CFD_tool/                      working directory (CFD-Tool layout)
        finished/caseA, finished/caseB    two simulations
        inProgress/, unsimulated/, archive/, Settings/

Each simulation mirrors the STAR-CCM+ post-processing export: image sections
named {Field}_{axis}-Section, a 3D scene gallery, PressureDistributions CSVs
(with header-only stations, like real exports), and plots/Coefficients_49.csv
with the real monitor column names. caseA also has a tiny EnSight Gold binary
case in 3D-data. caseB lacks the 2460 mm FW x-station that caseA plots first,
so pressure overlays must fall back to caseB's nearest station (2440 mm).
"""

import struct
import zlib
from pathlib import Path

SECTIONS = {
    ("Cp", "x"): 12,
    ("Cp", "y"): 6,
    ("CpT", "x"): 6,
    ("Velocity", "x"): 6,
    ("Lambda2", "x"): 4,
}
X_STATIONS = [2500 - 20 * index for index in range(12)]  # 2500 ... 2280 mm
Y_STATIONS = [10 * index for index in range(6)]  # 0 ... 50 mm

COEFFICIENT_HEADERS = [
    "Iteration",
    "CzA Front (percentage) Monitor: CzA Front (percentage) Monitor",
    "CzA Monitor: CzA Monitor",
    "CzA Frontwing Monitor: CzA Frontwing Monitor",
    "CzA Undertray Monitor: CzA Undertray Monitor",
    "CzA Rearwing Monitor: CzA Rearwing Monitor",
    "CzA Mono Monitor: CzA Mono Monitor",
    "CzA Remaining Monitor: CzA Remaining Monitor",
    "CxA Monitor: CxA Monitor",
    "CxA Frontwing Monitor: CxA Frontwing Monitor",
    "CxA Undertray Monitor: CxA Undertray Monitor",
    "CxA Rearwing Monitor: CxA Rearwing Monitor",
    "CxA Mono Monitor: CxA Mono Monitor",
    "CxA Remaining Monitor: CxA Remaining Monitor",
]

# Final-iteration values: CzA (total) and CxA (total) are negative, as in the
# team's convention where negative means downforce/drag.
FINAL_VALUES = {
    "caseA": [1000, 0.45, -3.2, -1.1, -1.4, -0.9, 0.1, 0.1, -1.25, -0.3, -0.2, -0.5, -0.15, -0.1],
    "caseB": [1000, 0.48, -3.5, -1.2, -1.5, -1.0, 0.1, 0.1, -1.4, -0.35, -0.2, -0.55, -0.2, -0.1],
}

# EnSight per-element field values: (tria3 cell 1, tria3 cell 2, quad4 cell).
ENSIGHT_FIELDS = {
    "CpX": (-2.25, 0.5, 1.125),
    "PressureCoefficient": (-1.5, 0.25, 0.75),
}


def png(width, height, rgb):
    """Minimal solid-colour RGB PNG."""
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def record(text):
    """80-byte EnSight binary text record."""
    return text.encode("ascii").ljust(80, b"\x00")


def write_ensight(folder):
    """Two-triangle + one-quad surface part with per-element fields."""
    folder.mkdir(parents=True, exist_ok=True)
    nodes = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0), (2, 0, 0), (2, 1, 0)]
    geometry = b"".join([
        record("C Binary"), record("HoMo CFD test geometry"), record("synthetic"),
        record("node id off"), record("element id off"),
        record("part"), struct.pack("<i", 1), record("Frontwing"),
        record("coordinates"), struct.pack("<i", len(nodes)),
        struct.pack(f"<{len(nodes)}f", *[n[0] for n in nodes]),
        struct.pack(f"<{len(nodes)}f", *[n[1] for n in nodes]),
        struct.pack(f"<{len(nodes)}f", *[n[2] for n in nodes]),
        record("tria3"), struct.pack("<i", 2), struct.pack("<6i", 1, 2, 3, 2, 4, 3),
        record("quad4"), struct.pack("<i", 1), struct.pack("<4i", 2, 5, 6, 4),
    ])
    (folder / "test.geo").write_bytes(geometry)
    lines = ["FORMAT", "type: ensight gold", "", "GEOMETRY", "model: test.geo", "", "VARIABLE"]
    for name, (t1, t2, q1) in ENSIGHT_FIELDS.items():
        values = b"".join([
            record(name), record("part"), struct.pack("<i", 1),
            record("tria3"), struct.pack("<2f", t1, t2),
            record("quad4"), struct.pack("<1f", q1),
        ])
        (folder / f"test.{name}").write_bytes(values)
        lines.append(f"scalar per element: {name} test.{name}")
    (folder / "test.case").write_text("\n".join(lines) + "\n", encoding="ascii")


def pressure_csv(path, axis, station, populated):
    direction = "Direction [0,1,0] (mm)" if axis == "x" else "Direction [1,0,0] (mm)"
    prefix = f"fw_{axis}-section"
    lines = [f'"{prefix}: {direction}","{prefix}: Pressure Coefficient"']
    if populated:
        for index in range(40):
            coordinate = 100 + index * 15
            cp = -2.5 + (index % 20) * 0.18 + station / 10000
            lines.append(f"{coordinate},{cp:.6f}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_case(case_dir, name):
    case_dir.mkdir(parents=True, exist_ok=True)
    shade = 60 if name == "caseA" else 140
    for (field, axis), count in SECTIONS.items():
        folder = case_dir / f"{field}_{axis}-Section"
        folder.mkdir()
        stations = X_STATIONS if axis == "x" else Y_STATIONS
        for index in range(count):
            colour = (shade, (index * 20) % 256, 200 - index * 10)
            (folder / f"{index + 1:03d}_{field}_{axis}-Section_{stations[index]}mm.png").write_bytes(png(160, 90, colour))
    gallery = case_dir / "3D"
    gallery.mkdir()
    for index, scene in enumerate(["Cp", "CpT", "SFC"]):
        (gallery / f"{index + 1:02d}_{scene}.png").write_bytes(png(160, 90, (shade, 80 + 40 * index, 90)))

    pressure = case_dir / "PressureDistributions"
    x_folder = pressure / "pd_FW_x-Section"
    y_folder = pressure / "pd_FW_y-Section"
    x_folder.mkdir(parents=True)
    y_folder.mkdir(parents=True)
    for index, station in enumerate(X_STATIONS[:5]):
        if name == "caseB" and station == 2460:
            continue  # caseB has no data at caseA's first populated station
        pressure_csv(x_folder / f"{index + 1:03d}_pd_FW_x-Section_{station}mm.csv", "x", station, populated=station <= 2460)
    for index, station in enumerate(Y_STATIONS[:3]):
        pressure_csv(y_folder / f"{index + 1:03d}_pd_FW_y-Section_{station}mm.csv", "y", station, populated=True)

    plots = case_dir / "plots"
    plots.mkdir()
    rows = [",".join(f'"{header}"' for header in COEFFICIENT_HEADERS)]
    final = FINAL_VALUES[name]
    for iteration in (998, 999):
        rows.append(",".join(str(iteration if i == 0 else value * 0.9) for i, value in enumerate(final)))
    rows.append(",".join(str(value) for value in final))
    (plots / "Coefficients_49.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (plots / "DONE").write_text("", encoding="utf-8")

    if name == "caseA":
        write_ensight(case_dir / "3D-data")


def build(root):
    """Create the fixture under root; returns the working directory path."""
    working_dir = Path(root) / "CFD_tool"
    for folder in ("inProgress", "unsimulated", "archive", "Settings"):
        (working_dir / folder).mkdir(parents=True, exist_ok=True)
    for name in ("caseA", "caseB"):
        write_case(working_dir / "finished" / name, name)
    return working_dir


if __name__ == "__main__":
    import sys

    print(build(sys.argv[1] if len(sys.argv) > 1 else "fixture"))
