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
# team's convention where negative means downforce/drag (coefficient × area).
FINAL_VALUES = {
    "caseA": [1000, 0.45, -3.2, -1.1, -1.4, -0.9, 0.1, 0.1, -1.25, -0.3, -0.2, -0.5, -0.15, -0.1],
    "caseB": [1000, 0.48, -3.5, -1.2, -1.5, -1.0, 0.1, 0.1, -1.4, -0.35, -0.2, -0.55, -0.2, -0.1],
}

# EnSight per-element field values of Frontwing: (tria3 cell 1, tria3 cell 2, quad4 cell).
ENSIGHT_FIELDS = {
    "CpX": (-2.25, 0.5, 1.125),
    "PressureCoefficient": (-1.5, 0.25, 0.75),
    "Velocity Magnitude": (10.0, 20.0, 30.0),
    # Wall shear stress direction for the surface flow lines: downstream (+X) with a part off the
    # surface (Z) on the triangles, reversed flow on the quad.
    "WallShearStressX": (1.0, 1.0, -1.0),
    "WallShearStressY": (0.0, 0.0, 0.0),
    "WallShearStressZ": (0.5, 0.5, 0.5),
}
# The flow case (export3D.java's <sim>_flow.case): Lambda2 triangle values; no wall fields such as CpX.
ENSIGHT_FLOW_FIELDS = {"PressureCoefficient": 0.0, "Velocity Magnitude": 25.0}
# The streamlines case (<sim>_streamlines.case): two rows (parts) of four lines (bar2) starting 5 cm in front
# of the car (Frontwing spans x 0…2) at y = 0, 0.25, 0.5, 0.75. Row 1 (z = 0.3) runs on to 1.5 m behind the car;
# the viewer cuts it at 1 m. Like STAR-CCM+, lines come in pieces: y = 0.5 is split at a shared point and
# y = 0.75 has a 0.5 mm gap. Row 2 (z = 0.6) is short.
LONG_X, SHORT_X = (2.05, 1.0, 0.0, -0.9, -1.5), (2.05, 1.0)
STREAMLINES = {
    "Streamlines 1": [[(x, 0.0, 0.3) for x in LONG_X], [(x, 0.25, 0.3) for x in LONG_X],
                      [(x, 0.5, 0.3) for x in LONG_X[:3]], [(x, 0.5, 0.3) for x in LONG_X[2:]],
                      [(x, 0.75, 0.3) for x in LONG_X[:3]], [(x, 0.75, 0.3) for x in (-0.0005,) + LONG_X[3:]]],
    "Streamlines 2": [[(x, y, 0.6) for x in SHORT_X] for y in (0.0, 0.25, 0.5, 0.75)],
}
ENSIGHT_STREAMLINE_FIELDS = {"PressureCoefficient": -0.5, "Velocity Magnitude": 22.0}


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
    """Car case (two-triangle + one-quad Frontwing, an empty part), a flow case with a Lambda2 part and a streamlines case."""
    folder.mkdir(parents=True, exist_ok=True)
    header = [record("C Binary"), record("HoMo CFD test geometry"), record("synthetic"),
              record("node id off"), record("element id off")]
    nodes = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0), (2, 0, 0), (2, 1, 0)]
    geometry = b"".join(header + [
        record("part"), struct.pack("<i", 1), record("Frontwing"),
        record("coordinates"), struct.pack("<i", len(nodes)),
        struct.pack(f"<{len(nodes)}f", *[n[0] for n in nodes]),
        struct.pack(f"<{len(nodes)}f", *[n[1] for n in nodes]),
        struct.pack(f"<{len(nodes)}f", *[n[2] for n in nodes]),
        record("tria3"), struct.pack("<i", 2), struct.pack("<6i", 1, 2, 3, 2, 4, 3),
        record("quad4"), struct.pack("<i", 1), struct.pack("<4i", 2, 5, 6, 4),
        # An empty boundary, as a half-car export can contain (e.g. the other side's wheel).
        record("part"), struct.pack("<i", 2), record("wheel-fr"), record("coordinates"), struct.pack("<i", 0),
    ])
    (folder / "test.geo").write_bytes(geometry)
    lines = ["FORMAT", "type: ensight gold", "", "GEOMETRY", "model: test.geo", "", "VARIABLE"]
    for name, (t1, t2, q1) in ENSIGHT_FIELDS.items():
        values = b"".join([
            record(name), record("part"), struct.pack("<i", 1),
            record("tria3"), struct.pack("<2f", t1, t2),
            record("quad4"), struct.pack("<1f", q1),
            record("part"), struct.pack("<i", 2),
        ])
        file = name.replace(" ", "")
        (folder / f"test.{file}").write_bytes(values)
        lines.append(f"scalar per element: {name} test.{file}")
    (folder / "test.case").write_text("\n".join(lines) + "\n", encoding="ascii")

    # A derived part in the flow (vortex iso-surface), shown with its own checkbox.
    flow_geometry = b"".join(header + [
        record("part"), struct.pack("<i", 1), record("Lambda2"), record("coordinates"), struct.pack("<i", 3),
        struct.pack("<3f", 0, 1, 0), struct.pack("<3f", 0, 0, 1), struct.pack("<3f", 1, 1, 1),
        record("tria3"), struct.pack("<i", 1), struct.pack("<3i", 1, 2, 3),
    ])
    (folder / "test_flow.geo").write_bytes(flow_geometry)
    lines = ["FORMAT", "type: ensight gold", "", "GEOMETRY", "model: test_flow.geo", "", "VARIABLE"]
    for name, value in ENSIGHT_FLOW_FIELDS.items():
        file = name.replace(" ", "")
        (folder / f"test_flow.{file}").write_bytes(b"".join([
            record(name), record("part"), struct.pack("<i", 1), record("tria3"), struct.pack("<1f", value)]))
        lines.append(f"scalar per element: {name} test_flow.{file}")
    (folder / "test_flow.case").write_text("\n".join(lines) + "\n", encoding="ascii")

    # Streamlines: one part per row of start points, each piece a polyline of bar2 segments with its own points.
    parts, point_counts = [], []
    for part_id, (name, pieces) in enumerate(STREAMLINES.items(), start=1):
        points, bars = [], []
        for piece in pieces:
            bars += [index for segment in range(len(points) + 1, len(points) + len(piece)) for index in (segment, segment + 1)]
            points += piece
        point_counts.append(len(points))
        parts += [record("part"), struct.pack("<i", part_id), record(name), record("coordinates"), struct.pack("<i", len(points))]
        parts += [struct.pack(f"<{len(points)}f", *[point[axis] for point in points]) for axis in range(3)]
        parts += [record("bar2"), struct.pack("<i", len(bars) // 2), struct.pack(f"<{len(bars)}i", *bars)]
    (folder / "test_streamlines.geo").write_bytes(b"".join(header + parts))
    lines = ["FORMAT", "type: ensight gold", "", "GEOMETRY", "model: test_streamlines.geo", "", "VARIABLE"]
    for name, value in ENSIGHT_STREAMLINE_FIELDS.items():
        file = name.replace(" ", "")
        values = [record(name)]
        # As STAR-CCM+ writes them, despite "per element" in the case file: one value per point, padded with zeros
        # of varying length, records padded with spaces. Row 1: values, then 2 × points zeros. Row 2: its last
        # piece (2 points) comes later in the block, after zeros.
        for part_id, count in enumerate(point_counts, start=1):
            block = [value] * count + [0.0] * (2 * count) if part_id == 1 else \
                [value] * (count - 2) + [0.0] * 8 + [value] * 2 + [0.0] * 5
            values += [b"part".ljust(80, b" "), struct.pack("<i", part_id), b"coordinates".ljust(80, b" "),
                       struct.pack(f"<{len(block)}f", *block)]
        (folder / f"test_streamlines.{file}").write_bytes(b"".join(values))
        lines.append(f"scalar per element: {name} test_streamlines.{file}")
    (folder / "test_streamlines.case").write_text("\n".join(lines) + "\n", encoding="ascii")


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

    write_solver_log(case_dir / "resTAURANtS.o4100", name)
    if name == "caseA":
        write_ensight(case_dir / "3D-data")


# STAR-CCM+'s iteration table in the solver's job log: names right-aligned over their columns, the header
# repeated every 10 iterations, other output in between (the real logs also hold the licence key).
SOLVER_LOG_NAMES = ["Continuity", "X-momentum", "Y-momentum", "Z-momentum", "Tke", "Sdr", "CzA Front (percentage)", "CzA", "CxA", "CzA Frontwing"]


# caseB: residuals twice as large, CzA 0.1 lower.
def solver_cza(iteration, name="caseA"):
    return -3.0 - iteration / 100 - (0.1 if name == "caseB" else 0)


def solver_residual(iteration, column, name="caseA"):
    return 10 ** (-(iteration / 10) - column / 2) * (2 if name == "caseB" else 1)


def write_solver_log(path, name):
    # Columns are 15 wide, wider for long names ("CzA Front (percentage)"), as in STAR-CCM+'s logs.
    widths = [max(15, len(name) + 1) for name in SOLVER_LOG_NAMES]
    header = f"{'Iteration':>14}" + "".join(f"{name:>{width}}" for name, width in zip(SOLVER_LOG_NAMES, widths))
    lines = ["Starting STAR-CCM+ parallel server", "podkey FAKE-LICENCE-KEY-0000"]
    for iteration in range(1, 31):
        if iteration % 10 == 1:
            lines += ["", header]
        residuals = [solver_residual(iteration, column, name) for column in range(6)]
        values = residuals + [0.45, solver_cza(iteration, name), -1.25, -1.1]
        lines.append(f"{iteration:>14}" + "".join(f"{value:>{width}.6e}" for value, width in zip(values, widths)))
        if iteration == 15:
            lines.append("  2 processes still running")  # starts with a digit, but is no table row
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
