# HoMo CFD — shared context (Cursor + ChatGPT)

This file is the single source of truth. Paste it into ChatGPT when starting a turn. Cursor keeps `STATUS.md` updated after each implementation step.

## People and goal

- Owner: Sem (mechanical engineering / Formula Student aero, not a software engineer).
- Product: **HoMo CFD** — a modern replacement for the existing Java **CFD-Tool**, then a real analysis platform.
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

The current UI intentionally exposes this tree in a searchable filesystem panel. Selecting a result or subfolder filters the collective coefficient summary; selecting an image-section folder opens its images in a separate viewer window.

## Filename convention: intentionally NOT used for navigation

Filenames are not parsed for position. Each image-section folder's images are sorted naturally by filename and stepped through by index with left/right arrow keys. The filename remains visible beneath the image. Zoom is available, with optional synchronization across separate viewer windows.

`PressureDistributions/` CSVs (e.g. `001_pd_FW_x-Section_2500mm.csv`) are confirmed to have headers (`... Direction [0,1,0] (mm)`) but the one sample supplied had **no data rows**. These files are not displayed in the current UI; defer pressure-distribution graphing until a populated sample is available.

## Coefficients summary (confirmed, implemented)

Each case's `plots/` subfolder contains a `Coefficients*.csv` (e.g. `Coefficients_49.csv`): one row per solver iteration, with CzA/CxA component-monitor columns. The UI aggregates these files into the only displayed table: one row per simulation, using only each file's final iteration. Coefficient values display to three decimal places; the iteration number remains an integer. Do not display full coefficient histories or other CSV tables.

## Product stages (agreed)

| Stage | Meaning |
| --- | --- |
| 0 | Reverse-engineer STAR-CCM+ → folders → CFD-Tool |
| 1 | Design screens (cases, field, section, viewer, plots) |
| 2 | Tiny app: open → select a case → see it |
| 3 | Filesystem-first CSV browser with separate image-folder windows |
| 4 | CSV pressure plots (blocked on a populated sample CSV) |
| 5 | FSAE-specific aerodynamic comparison |
| 6 | Interactive CFD fields (VTK / 3D), not only PNGs |
| 7 | Fritz: submit, monitor, download, delete |

**V1 = modern CFD-Tool** (PNG image sequences + browsable CSV tables). Do not start with a generic ParaView clone.

### Stage 3, revised: filesystem-first CSV browser and image windows

- Choose the results root once. Store its File System Access API handle in IndexedDB and restore it on later visits when permission is still granted.
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
- Plots: Plotly when CSVs land.
- 3D: Three.js / R3F only after PNG viewer works.
- Local-first: user points the app at a result folder on disk (no cluster upload in V1).

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
