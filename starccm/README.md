# STAR-CCM+ macros for HoMo CFD

Two macros for the template folder on Fritz (e.g. `SCRIPT_RANS`), for
STAR-CCM+ 2506 (20.04). Tested on Fritz on 2026-10-02: a post job on
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

Exports the car's surfaces with per-cell fields (PressureCoefficient,
TotalPressureCoefficient, CpX, CpZ, CpZCpX) as EnSight Gold into `3D-data/`
next to the `.sim`. HoMo CFD shows such a folder in the results tree as
**3D-data · 3D viewer**. A full car is about 70 MB plus about 6 MB per field.

- Only **wall** boundaries are exported. Wind-tunnel walls are skipped by name
  (`floor`, `ground`, `road`, `walls`, `wall`, `tunnel`, `symmetry`, `sym`,
  `top`, `side`), and so are interfaces (`internal…`, names with `[`). Edit
  `SKIPPED` at the top of the macro if your domain uses other names.
- Fields the simulation does not have are left out (e.g. `CpZCpX` in
  `0830_mk2.2_10degree`); problems are written to the log and never stop the
  post-processing.
- STAR-CCM+ may add a few tiny pieces of the walls (named like `rim 3`) without
  values; the viewer shows them grey.

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
