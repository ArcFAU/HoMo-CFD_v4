# STAR-CCM+ macros for HoMo CFD

Two macros for the template folder on Fritz (e.g. `SCRIPT_RANS`), for
STAR-CCM+ 2506 (20.04). **Installed in `SCRIPT_RANS` on 2026-10-02** (the
previous macro is kept there as `postprocessing.java.bak`), so new simulations
created from it export 3D data. Tested on Fritz on 2026-10-02: a post job on
`0830_mk2.2_10degree` (57 min) wrote `3D-data` with the full car (74 MB
geometry + 6 MB per field), which opens in HoMo CFD's 3D viewer.

The case folder needs its `Settings`: `postprocessing.java` reads it first and
stops without it.

## postprocessing.java

The team's post-processing macro (section images, 3D scene pictures, pressure
distributions, plots), taken from `SCRIPT_RANS` on 2026-10-02, with two
changes:

- After the 3D scene pictures it plays `export3D.java` from the case folder
  (method `export3DData()`). If that file is missing, nothing happens; if the
  export fails, one line goes to the log and the rest of the post-processing
  runs as before.
- An unused field with a personal Fritz path (`workingDir`) was removed.

## export3D.java: 3D data for the 3D viewer

Exports EnSight Gold into `3D-data/` next to the `.sim`; HoMo CFD shows such a
folder in the results tree as **3D-data · 3D viewer**:

- **The car's wall surfaces** with per-cell fields: PressureCoefficient,
  TotalPressureCoefficient, CpX, CpZ, CpZ-CpX, SkinFrictionCoefficient,
  WallYplus, and the magnitudes of WallShearStress, Velocity and
  VorticityVector. A full car is about 70 MB plus about 6 MB per field.
- **The simulation's derived part `Lambda2`** (iso-surface of `neg(Lambda2)` at
  30000 in `UPSI_CFD_BASE`: the vortex cores), in a second case
  `<sim>_flow.case` with the fields defined in the flow (PressureCoefficient,
  TotalPressureCoefficient, Velocity and Vorticity magnitude); the viewer shows
  it with a **Vortices (λ2)** checkbox. Wall fields are left out there: `CpX`
  = Cp × `Norm_Area_x` divides by a face area that is zero on some iso-surface
  faces, which stopped STAR-CCM+ with a floating point error in a test run.
  Without such a part the macro makes a temporary one from `neg(Lambda2)`.
- **The derived part `Bad_Cells`** (iso-surface around bad mesh cells), also in
  `<sim>_flow.case`, off by default in the viewer (**Bad cells** checkbox).

The car and the flow parts are two separate exports, so a problem with the flow
parts never costs the car data. The viewer reads all `.case` files of a
`3D-data` folder as one model.
- **`fields.txt`**: every field function of the simulation (name, display name,
  type), to look up names.

Fields are found by name or display name, ignoring case and punctuation, so
`CpZ-CpX` and `CpZCpX` both work. Regions named `Cells deleted from …` (left
over from mesh repair, no solution) are skipped.

Optional lines in the case's `Settings`:

```text
3D-Data/Vortices : false              no Lambda2 part
3D-Data/Bad Cells : false             no Bad_Cells part
3D-Data/Vortices Iso Value : 30000    only for the temporary part, when the simulation has no Lambda2 part
```

- Only **wall** boundaries are exported. Wind-tunnel walls are skipped by name
  (`floor`, `ground`, `road`, `walls`, `wall`, `tunnel`, `symmetry`, `sym`,
  `top`, `side`), and so are interfaces (`internal…`, names with `[`). Edit
  `SKIPPED` at the top of the macro if your domain uses other names.
- Fields or parts a simulation does not have are left out; problems are written
  to the log and never stop the post-processing.
- Test runs on Fritz (`exp`, 2026-10-02): version 1 missed `CpZ-CpX` and
  exported value-less pieces of the `Cells deleted` regions; version 2 wrote all
  10 car fields (y+ 0–128, skin friction up to 0.11, velocity 0 on fixed walls
  and up to 11 m/s on the rotating wheels) but no values on Lambda2/Bad_Cells
  (floating point error from `Norm Area x`); version 3 (two exports) is
  installed and being tested.

### Try it once by hand

Open a finished case's `.sim` in STAR-CCM+, then **File → Macro → Play Macro…**
and choose `export3D.java`. A `3D-data` folder appears next to the `.sim`; open
it in HoMo CFD (results tree, or **Open 3D Cp viewer**).

## Use them for every new simulation

Copy both files into the template folder on Fritz, replacing the template's
`postprocessing.java` (keep the old one, e.g. as `postprocessing.java.bak`).
**New simulation on Fritz** in HoMo CFD copies them into every new case. Cases
that already exist keep their old macro.

If your template's `postprocessing.java` has changed since 2026-10-02, add the
two changes by hand instead: the call

```java
            // Surfaces with Cp fields for HoMo CFD's 3D viewer (3D-data/), see export3D.java.
            export3DData();
```

after the loop that calls `exportThree(three);`, and the method
`export3DData()` from this folder's `postprocessing.java`.
