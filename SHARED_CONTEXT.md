# HoMo CFD — shared context (Cursor + ChatGPT)

This file is the single source of truth. Paste it into ChatGPT when starting a turn. Cursor keeps `STATUS.md` updated after each implementation step.

## People and goal

- Owner: Sem (mechanical engineering / Formula Student aero, not a software engineer).
- Product: **HoMo CFD** — a modern replacement for the existing Java **CFD-Tool**, then a real analysis platform.
- Distribution: once finished, HoMo CFD will be shared with other people (teammates). Keep setup simple (Python stdlib, no build step), keep machine-specific settings out of the app folder (the working directory is saved per user in `%APPDATA%\HoMo-CFD\settings.json`), work fully offline, and write setup docs for non-programmers. Each person runs HoMo CFD on their own computer against their own results, which may live on any path. `serve.py` currently listens on 127.0.0.1 only; serving teammates over a network would need an explicit opt-in and a security review first.
- Cluster: NHR FAU Fritz. Solver: STAR-CCM+. Current remote flow: laptop `.sim` → WinSCP → mesh / RANS / post macros → download images/plots → CFD-Tool.

## Current production workflow (do not throw away)

1. Prepare the simulation in STAR-CCM+ on the laptop.
2. Upload the `.sim` to Fritz (WinSCP).
3. Run mesh, then RANS, then post macros (SLURM). A `Settings` file drives mesh, physics, scenes, vehicle state, and run flags.
4. Postprocessing writes many folders of PNG scenes plus CSVs (pressure distributions) and residual plots.
5. Download results. CFD-Tool loads **up to four cases** at once and shows images + matching pressure-distribution CSVs.

### Settings (what the team already toggles)

Vehicle: half-car wind tunnel, ride heights ~35 mm, velocity 40, yaw/pitch/steer 0, wheelbase 1530, etc.

Scenes (examples):

- X sections: start 2500 → end −500, resolution 20. Fields: Cp, Velocity, CpT, Lambda2 (TKE/Mesh off by default).
- Y sections: 0 → 800, resolution 10. Cp / Velocity / CpT on.
- Z sections: 0 → 1100, resolution 5. Cp / Velocity / CpT on.
- 3D scenes: Cp, CpT, Cp Z, Cp X, Cp Z − Cp X, SFC, SFC_FlowPattern.
- Pressure distribution: FW / UT / RW × x/y sections (z off by default).
- Plots: residuals on.

Post job: 1 node, STAR-CCM+ batch `postprocessing.java`.

## Result folder layout (from Sem’s screenshot)

Treat folders as a database. Pattern: `{Field}_{axis}-Section`.

Known groups:

- `CpT_x-Section`, `CpT_y-Section`, `CpT_z-Section`
- `Lambda2_*`, `Velocity_*`, `TKE_*`, `Mesh_*` (same x/y/z)
- `PressureDistributions/`
- `plots/`
- residual / inspection quantities (TKE per volume, Laplace(TP), continuity/momentum residuals, …)

The current UI intentionally exposes this tree in a searchable filesystem panel. Selecting a result or subfolder filters the collective coefficient summary; selecting an image-section folder opens its images in a separate viewer window. A folder named `3D` that contains static images opens a dedicated 3D reference-scene gallery window.

## Filename convention: intentionally NOT used for navigation

Filenames are not parsed for position. Each image-section folder's images are sorted naturally by filename and stepped through by index with left/right arrow keys. The filename remains visible beneath the image. The static `3D` reference gallery uses the same natural filename ordering and left/right keys. Zoom is available, with optional synchronization across separate viewer windows.

`PressureDistributions/` contains six groups: `pd_FW_x/y-Section`, `pd_UT_x/y-Section`, and `pd_RW_x/y-Section`. The supplied `0830_mk3` case has populated CSVs with two columns: a directional coordinate in mm and `Pressure Coefficient`. X-section files use `Direction [0,1,0]` (transverse y coordinate); y-section files use `Direction [1,0,0]` (longitudinal x coordinate). Filenames include the section station in mm, for example `005_pd_FW_x-Section_2420mm.csv`. Some station files have headers but no data rows; skip those when plotting. The sample has 150 x-stations and 80 y-stations per group, with populated-file counts FW x/y 38/76, UT x/y 147/72, RW x/y 37/72.

Pressure-distribution groups in the filesystem tree open their matching pressure plot directly in an immersive workspace that hides the folder tree. The chart overlays up to four selected cases with distinct colors; each case uses its nearest populated station when exact stations differ. Header-only station files are omitted. Stations follow the natural CSV sequence from front to back, are stepped with keyboard left/right, and have no position dropdown. The chart uses the legacy fixed Cp range (-5 to +1), with positive Cp plotted downward and negative Cp upward; pressure-side samples (Cp > +0.1) and suction-side samples (Cp < -0.1) use separate colors within each case. Scene images are optional; when added, choose Cp, Velocity, CpT, or Lambda2 and they stay linked to the pressure plot's axis and station plane. The plot and images share one viewport. One image gets the larger view, two are stacked, and three or four use a two-by-two grid. Image case names and filenames are not repeated around each image, and image gaps are removed. Inspection of the old plot bytecode indicates its “upper/lower” groups refer to Cp thresholds, not physical geometry curves.

## Coefficients summary (confirmed, implemented)

Each case's `plots/` subfolder contains a `Coefficients*.csv` (e.g. `Coefficients_49.csv`): one row per solver iteration, with CzA/CxA component-monitor columns. The UI aggregates these files into the only displayed table: one row per simulation, using only each file's final iteration. Coefficient values display to three decimal places; the iteration number remains an integer. Do not display full coefficient histories or other CSV tables.

The table's Stage 5 comparison mode can show signed `case - reference` differences for each exported monitor column, keyed by its original CSV header. A collapsible raw-monitor bar chart compares one selected monitor across the visible simulations. The reference row should be zero; the default values view remains available.

Sign convention confirmed by the team (2026-10-02): `CzA` and `CxA` are the downforce and drag coefficients × reference area (not forces); negative `CzA` is downforce and negative `CxA` is drag; `CzA Front (percentage)` is a fraction (0.48 = 48 % front). The exported monitors stay as they are. HoMo CFD adds two computed columns right after Iteration: `Downforce [N]` and `Drag [N]` = ½ · ρ · v² · (−CzA / −CxA) from the total monitors, at a speed (km/h) and air density chosen in the table toolbar (defaults 60 km/h, 1.18415 kg/m³; added at the user's request). They are positive for downforce / drag, so a positive Δ means more than the reference. Then `L/D` = CzA ÷ CxA (= Downforce ÷ Drag, independent of speed and density). Do not add sign-flipped −CzA / −CxA columns or a separate balance column (the user had them removed). Do not convert `CzA Front` or the component monitors, and do not add further derived metrics (component forces, balance from components) without the team's confirmation. The exported monitors keep their units (coefficient × area); only Downforce [N] and Drag [N] are forces in newtons.

The legacy `CFD-Tool.zip` `resources/tables` presets confirm display aliases for `CzPercentageFront`, total `CzA`/`CxA`, and FW/UT/RW/Mono/Remaining component monitors. These presets configure labels and visibility only; inspection found no formulas, signs, or units. The sign convention above was supplied by the team instead. Do not open the possible `p.ppk` archive entry.

## Product stages (agreed)

| Stage | Meaning |
| --- | --- |
| 0 | Reverse-engineer STAR-CCM+ → folders → CFD-Tool |
| 1 | Design screens (cases, field, section, viewer, plots) |
| 2 | Tiny app: open → select a case → see it |
| 3 | Filesystem-first CSV browser with separate image-folder windows |
| 4 | CSV pressure plots (FW/UT/RW × x/y section and station) |
| 5 | FSAE-specific aerodynamic comparison |
| 6 | Interactive CFD fields (VTK / 3D), not only PNGs |
| 7 | Fritz: prepare, submit, monitor, download (no remote delete) — design decided in `docs/STAGE7_FRITZ.md` |

**V1 = modern CFD-Tool** (PNG image sequences + browsable CSV tables). Do not start with a generic ParaView clone.

### Stage 3, revised: filesystem-first CSV browser and image windows

- Preferred (mirrors CFD-Tool): `serve.py` holds a per-user **working directory**, like CFD-Tool's `%APPDATA%\CFD-Tool\resources\workingDir`. Precedence: `--working-dir` for one run, then HoMo's saved setting in `%APPDATA%\HoMo-CFD\settings.json`, then CFD-Tool's saved working directory, else the app shows **Choose working directory** on first start (native folder dialog via tkinter, or a pasted path). Results are read from `<working dir>\finished` when present (CFD-Tool layout: finished/inProgress/unsimulated/archive/Settings), else from the folder itself. `Start HoMo CFD.bat` starts the server and opens the browser. The server indexes the results folder on start-up and serves listings and files read-only through `/api/tree`, `/api/list`, and `/api/file` (127.0.0.1 only; `..`, drive letters, and hidden entries rejected). `web/server-fs.js` exposes these as File System Access-style handles, so the rest of the app is unchanged. Agreed in the ChatGPT design conversation ("predetermined results folder, no picker every time"); implemented 2026-10-02.
- Fallback when no root is configured: choose the results root once in Chrome/Edge. Store its File System Access API handle in IndexedDB and restore it on later visits when permission is still granted (one-click Reconnect otherwise).
- The left panel is a searchable filesystem tree. Selecting the root or a simulation filters the collective coefficient summary to the corresponding subtree.
- The main area contains exactly one collective table: final coefficients iteration per simulation. Do not render other CSVs as tables.
- **Customize columns** lets users rename, hide, and reorder coefficient columns; preferences persist per browser. Rendered values must be resolved from original CSV headers, never by the display label or current column position.
- Clicking a folder matching `{Field}_{axis}-Section` opens a separate comparison window seeded with its parent simulation and that field/axis. The window can add up to three more simulations. Do not show comparison case slots in the main window or read image sequences until the user opens them.
- Each simulation panel has independent field, axis, and frame state, so different result types can be compared. Zoom and normalized pan are always synchronized across panels, with no UI toggles. Left/right arrow keys step the focused panel by default; optional **Sync images** steps all panels by frame index and holds shorter sequences at their last image. Keep images contained at fit size and allow scrolling when zoomed.
- Keep section image bytes unloaded during root indexing. Preserve the original PNGs and read only the final data row from each coefficients history.
- Do not add 3D/VTK, ParaView-style panning, or CFD solving in this stage.

## Stack (agreed)

- Web app from day one (easier for AI-assisted work; teammates can open a URL later).
- Frontend: first versions are vanilla HTML/JS in `web/` served by `py serve.py` (this PC has Python, not Node). We can move to React later if needed.
- Later: Python FastAPI + PyVista / meshio / VTK for real fields.
- Plots: lightweight inline SVG for pressure distributions; add a chart library only if later plots require richer interaction.
- 3D: Three.js / R3F only after PNG viewer works.
- Interactive 3D first step: a separate WebGL2 surface viewer reads STAR-CCM+ EnSight Gold geometry plus a per-element scalar from a selected `3D-data` folder. Initial preview scope is Cp on `tria3` / `quad4` surfaces; volume cuts and broader format support remain later work.
- The workspace's `0830_mk3/3D-data` folder currently contains a manageable EnSight Gold Frontwing surface case with five per-element fields: `CpX`, `CpZ`, `CpZCpX`, `PressureCoefficient`, and `TotalPressureCoefficient`. The viewer triangulates `tria3`, `quad4`, and `nsided` faces, offers field and editable range controls, **Auto range** based on the rendered surface values, and signed-axis orthographic presets (+/−X, +/−Y, +/−Z) plus isometric. The user confirmed their selected full-car export renders and considers that sufficient; do not block work on re-exporting it. The workspace Frontwing sample has ranges CpX −2.751…+2.343, CpZ −3.319…+2.135, CpZCpX −4.507…+2.957, and PressureCoefficient/TotalPressureCoefficient −3.720…+1.305. The +1 maximum therefore clips positive values in this local sample, but the interface can be adjusted or auto-ranged. The `0830_mk3/3D/` folder contains 21 static reference scenes (Cp/CpT/directional Cp/SFC/flow pattern); these open in a standalone image gallery from the searchable filesystem tree, with left/right arrow navigation. The user also supplied X/Y/Z sequences, Lambda2 X images, pressure CSVs, component coefficient histories, and job/report reference files in this case folder; inspect/use them when their workflow feature is next in scope. A previously inspected 4.58 GB volume export with an `Air` part was superseded; it should not be treated as the current sample.
- Local-first: user points the app at a result folder on disk (no cluster upload in V1), preferably by configuring it in `serve.py`.

## Cooperation rules (Cursor + ChatGPT)

1. **ChatGPT** owns product design, aero requirements, UI copy, and “what should this button do?”
2. **Cursor** owns code in this repo, running the app, and fixing errors.
3. Neither invents a new architecture without updating this file.
4. One feature at a time. No giant one-shot app.
5. Sem does not need to learn React first. Sem describes aero intent (“same X for all four cases”).
6. Secrets stay out of git. Do not commit STAR-CCM+ license keys, podkeys, or cluster credentials (one appeared in an old batch script; never copy it here).
7. After Cursor implements something, Sem can paste `STATUS.md` into ChatGPT so ChatGPT does not re-explain completed work.

## Out of scope for the next few versions

- Uploading huge `.sim` files to the browser
- Full STAR-CCM+ format support
- Adjoint / mesh generation UI
- Replacing PuTTY/WinSCP immediately

Scatter pressure plots now assign each case a distinct marker symbol: circle, square, triangle, or diamond. Both pressure and suction points use that case symbol, while their Cp-side colors remain different. The graph legend shows each case's marker on both color swatches.
