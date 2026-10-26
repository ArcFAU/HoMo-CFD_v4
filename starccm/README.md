# STAR-CCM+ macros for HoMo CFD

Macros for the team's simulations on Fritz, for STAR-CCM+ 2506 (20.04): two
that export 3D data for HoMo CFD's 3D viewer at the end of the post-processing,
and the meshing macro, which can swap in new parts from CAD files.

- **mesh.java**: the team's meshing macro (template `SCRIPT_RANS`, 2025-11-13)
  with a reworked CAD import, see "New parts from CAD files" below.

- **postprocessing.java**: the team's post-processing macro (section images, 3D
  scene pictures, pressure distributions, plots) with one addition: after the 3D
  scene pictures it plays `export3D.java` from the case folder. If that file is
  missing, nothing happens; if the export fails, one line goes to the log and the
  rest of the post-processing runs as before.
- **export3D.java**: writes the 3D data (below).

The case folder needs its `Settings` file: `postprocessing.java` reads it first
and stops without it.

## Use them for every new simulation

1. In WinSCP, open your template folder on Fritz (the one HoMo CFD copies for
   **New simulation on Fritz**, e.g. `SCRIPT_RANS`).
2. Rename its `postprocessing.java` to `postprocessing.java.bak` (to keep it).
3. Copy `postprocessing.java` and `export3D.java` from this folder into it.

New simulations created from the template then export 3D data. Cases that
already exist keep their old macro.

If your template's `postprocessing.java` differs from the team version (your
own changes), keep yours and add two things by hand instead: the call

```java
            // Surfaces with Cp fields for HoMo CFD's 3D viewer (3D-data/), see export3D.java.
            export3DData();
```

after the loop that calls `exportThree(three);`, and the method `export3DData()`
from this folder's `postprocessing.java`.

## New parts from CAD files (mesh.java)

Put CAD files (`.stp`, `.step`, `.igs`, `.iges`, `.stl`) into the case folder
before starting it. Before meshing, `mesh.java` imports each one and replaces
the part group its name points to (case does not matter):

| File name contains | Replaces the parts in |
| --- | --- |
| `frontwing` or the word `FW` | C_FRONTWING |
| `undertray` or the word `UT` | C_UNDERTRAY |
| `deflector` | C_UNDERTRAY_DEFLECTORS (if the simulation has it) |
| `mono` | C_MONOCOQUE |
| `rearwing` or the word `RW` | C_REARWING |
| anything else | nothing; added to z_000_remaining-parts |
| anything else, with `replace` in the name | z_000_remaining-parts (e.g. `remaining_replace_v2.stl`) |

"Word" means separated by `_`, `-`, spaces or dots: `FW_V1.stp`,
`1008_RW_V4.step` and `frontwing_v3.stp` all work. Every part the import
creates goes into the group, so a STEP assembly with many bodies is fine.
Several files can fill one group: its old parts are removed only once. The CAD
must be in the car's coordinates (the macro does not move or mirror it).

**STL or STEP?**

- **STL (recommended on Fritz):** read with STAR-CCM+'s own STL reader, which
  needs no extra licence. STL files must be in **millimetres** (NX exports STL
  in the part's unit, mm). Export with a fine tolerance; the surface wrapper
  re-meshes the surface anyway.
- **STEP / IGES:** need a **CAD Exchange** licence. On Fritz this licence is
  shared and is not always free: on 2026-10-09 STEP imports worked, on
  2026-10-14 the same import got "Could not find CAD Exchange license".

After each import the log lists what the group now contains, e.g.
`addCAD:   C_UNDERTRAY contains undertray_v3 [MeshPart, 1 surface(s)]`.

**A failed import stops the meshing.** The file and the reason go to the
`ERRORS` file in the case folder and to the log (`addCAD: … not imported: …`),
and the macro ends without meshing or saving, so the simulation never runs
with the old parts by mistake. Fix the file (or wait for a free licence) and
start the case again. The template's `mesh.sh` still submits the solver after
the meshing job; that solver job then stops within minutes ("No Volume Mesh
found"). To stop it from being submitted at all, change the line
`sbatch rans.sh` in **your case's** `mesh.sh` (not in the template) to:

```sh
if [ -s ERRORS ]; then echo "ERRORS found, solver not started:"; cat ERRORS; else sbatch rans.sh; fi
```

**Test only the import:** create an empty file named `IMPORT_ONLY` in the
case folder. The macro then imports the CAD files, writes the log lines above
and stops: nothing is meshed or saved. Remove (or rename) the file before the
real run.

**Meshing done marker:** after a successful meshing and save the macro writes an
empty file `MESHED` in the case folder. A case's `mesh.sh` can start the solver
only when it exists (and there is no `ERRORS`), so a meshing that fails for any
reason never costs a solver run:

```sh
if [ -s ERRORS ] || [ ! -f MESHED ]; then echo "ERRORS or no MESHED, solver not started"; cat ERRORS 2>/dev/null; else sbatch rans.sh; fi
```

Changes against the template's version: parts are found by comparing the
simulation's parts before and after the import (the old code looked for one
part named like the file, which fails for assemblies and mixed-case names and
then stopped importing the remaining files); short names FW/UT/RW; one failing
file no longer stops the others; a missing deflector group no longer stops the
import; a hard-coded path of a former member, used only to label the scenes
with the simulation name, is replaced by the case folder's name. Since
2026-10-14 also: STL through the STL reader in mm, the group contents in the
log, no meshing after a failed import, and the `IMPORT_ONLY` test; since
2026-10-15 the `MESHED` marker and `replace` for z_000_remaining-parts.

## Try it once by hand

Open a finished case's `.sim` in STAR-CCM+, then **File → Macro → Play Macro…**
and choose `export3D.java`. A `3D-data` folder appears next to the `.sim`; open
it in HoMo CFD (results tree, or **Open 3D Cp viewer**).

## What export3D.java writes

Into `3D-data/` next to the `.sim` (EnSight Gold, values per cell); HoMo CFD
shows the folder in the results tree as **3D-data · 3D viewer**:

- **`<sim>.case`: the car's wall surfaces** with PressureCoefficient,
  TotalPressureCoefficient, CpX, CpZ, CpZ-CpX, SkinFrictionCoefficient,
  WallYplus, and the magnitudes of WallShearStress, Velocity and
  VorticityVector. A full car is about 70–90 MB plus about 7 MB per field.
  Also the wall shear stress direction as `WallShearStressX/Y/Z` (its three
  components; the macro makes these field functions for the export and removes
  them afterwards). The viewer draws them as **Surface flow** lines (like oil
  flow) and doesn't list them as fields.
- **`<sim>_flow.case`: the simulation's derived parts `Lambda2`** (vortex cores:
  iso-surface of `neg(Lambda2)`) **and `Bad_Cells`** (iso-surface around bad mesh
  cells), with the fields defined in the flow (PressureCoefficient,
  TotalPressureCoefficient, Velocity and Vorticity magnitude). The viewer shows
  them with the **Vortices (λ2)** and **Bad cells** checkboxes. Wall fields are
  left out there: `CpX` = Cp × `Norm_Area_x` divides by a face area that is zero
  on some iso-surface faces. Without a `Lambda2` part the macro makes a
  temporary one from the `neg(Lambda2)` field function.
- **`<sim>_streamlines.case`: streamlines** in 20 parts `Streamlines 1…20`, one
  per row of start points. The rows lie 5 cm in front of the car's nose, spread
  evenly over its height; each row has 40 start points across its width (800
  lines). The car's size comes from temporary min/max reports of `Position` on the
  car surfaces, in metres (simulations may use mm). Lines are traced downstream
  along `Velocity` through all regions, with the flow fields. STAR-CCM+ writes
  their values per point. The viewer shows them up to 1 m behind the car, with the
  **Streamlines** checkbox and a bar to choose which lines to show (every Nth row
  and line, height and width range of the start points).
- **`fields.txt`**: every field function of the simulation (name, display name,
  type), to look up names.

The car, the flow parts and the streamlines are three separate exports, so a
problem with the flow parts or the streamlines never costs the car data. Parts,
reports and field functions the macro creates are removed at the end, so playing
it by hand leaves the simulation as it was.

Details:

- Fields are found by name or display name, ignoring case and punctuation
  (`CpZ-CpX` = `CpZCpX`). Fields or parts a simulation does not have are left
  out.
- Only **wall** boundaries are exported. Wind-tunnel walls are skipped by name
  (`floor`, `ground`, `road`, `walls`, `wall`, `tunnel`, `symmetry`, `sym`,
  `top`, `side`), and so are interfaces (`internal…`, names with `[`). Edit
  `SKIPPED` at the top of the macro if your domain uses other names. Regions
  named `Cells deleted from …` (left over from mesh repair) are skipped.
- Optional lines in the case's `Settings`:

  ```text
  3D-Data/Vortices : false              no Lambda2 part
  3D-Data/Bad Cells : false             no Bad_Cells part
  3D-Data/Vortices Iso Value : 30000    only for the temporary part, when the simulation has no Lambda2 part
  3D-Data/Streamlines : false           no streamlines
  3D-Data/Streamline Rows : 20          rows of start points over the car's height (1–200)
  3D-Data/Streamlines Per Row : 40      start points per row across the car's width (2–200)
  3D-Data/Surface Flow : false          no wall shear stress direction
  ```
