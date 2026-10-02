# STAR-CCM+ macros for HoMo CFD

Two macros that make STAR-CCM+ export 3D data for HoMo CFD's 3D viewer at the
end of the post-processing on Fritz. For STAR-CCM+ 2506 (20.04).

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
- **`<sim>_flow.case`: the simulation's derived parts `Lambda2`** (vortex cores:
  iso-surface of `neg(Lambda2)`) **and `Bad_Cells`** (iso-surface around bad mesh
  cells), with the fields defined in the flow (PressureCoefficient,
  TotalPressureCoefficient, Velocity and Vorticity magnitude). The viewer shows
  them with the **Vortices (λ2)** and **Bad cells** checkboxes. Wall fields are
  left out there: `CpX` = Cp × `Norm_Area_x` divides by a face area that is zero
  on some iso-surface faces. Without a `Lambda2` part the macro makes a
  temporary one from the `neg(Lambda2)` field function.
- **`fields.txt`**: every field function of the simulation (name, display name,
  type), to look up names.

The car and the flow parts are two separate exports, so a problem with the flow
parts never costs the car data.

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
  ```
