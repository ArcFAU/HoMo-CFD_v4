# STAR-CCM+ macros for HoMo CFD

## export3D.java: 3D data for the 3D viewer

Exports the car's surfaces with per-cell fields (PressureCoefficient,
TotalPressureCoefficient, CpX, CpZ, CpZCpX) as EnSight Gold into `3D-data/`
next to the `.sim`. HoMo CFD shows such a folder in the results tree as
**3D-data · 3D viewer**. A full car is about 70 MB plus about 6 MB per field.

- Only **wall** boundaries are exported. Wind-tunnel walls are skipped by name
  (`floor`, `ground`, `road`, `walls`, `wall`, `tunnel`, `symmetry`, `sym`,
  `top`, `side`), and so are interfaces (`internal…`, names with `[`). Edit
  `SKIPPED` at the top of the macro if your domain uses other names.
- Fields the simulation does not have are left out; problems are written to
  the log and never stop the post-processing.
- Checked by compiling against STAR-CCM+ 2506 (20.04) on 2026-10-02. It has not
  run in STAR-CCM+ yet.

### Try it once by hand

Open a finished case's `.sim` in STAR-CCM+, then **File → Macro → Play Macro…**
and choose `export3D.java`. A `3D-data` folder appears next to the `.sim`; open
it in HoMo CFD (results tree, or **Open 3D Cp viewer**).

### Run it automatically after every simulation

1. Copy `export3D.java` into the template folder on Fritz (e.g. `SCRIPT_RANS`),
   so every new case gets it.
2. In the template's `postprocessing.java`, inside `if(postprocessing.contains("3"))`,
   after the loop that calls `exportThree(three);`, add:

   ```java
               // Surfaces with Cp fields for HoMo CFD's 3D viewer (3D-data/), see export3D.java.
               export3DData();
   ```

   and add this method to the class (for example before `exportThree`):

   ```java
       // Plays export3D.java from the case folder when it is there. Any problem is only
       // logged, so the rest of the post-processing always runs.
       private void export3DData()
       {
           File macro = new File(directory, "export3D.java");
           if (!macro.isFile()) {
               return;
           }
           try {
               new StarScript(getActiveRootObject(), macro).play();
           } catch (Throwable e) {
               simulation_0.println("3D export skipped: " + e);
           }
       }
   ```

Cases without `export3D.java` in their folder simply skip the export.
