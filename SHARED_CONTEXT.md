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

The UI must **not** make the user walk that tree. They pick:

- cases (up to 4, later more)
- field (Cp, CpT, Velocity, Lambda2, TKE, Mesh, …)
- section axis (X / Y / Z)
- position along the axis (slider)

The app resolves that to the correct PNG (and later CSV).

## Filename convention: intentionally NOT used for navigation

Filenames were briefly parsed for an mm position (`001_Velocity_x-Section_2500mm`), but real usage showed this doesn't work: some fields (e.g. `Lambda2`) are only ever computed on one axis, so "sync by mm across cases/fields" produced confusing not-a-bug "Section unavailable" states that read as broken. **Correction, superseding the mm-based design below**: the app now reads nothing out of image filenames. Each `Field_axis-Section/` folder's images are just sorted by filename (natural sort) into a plain ordered sequence, stepped through by index (prev/next buttons, left/right arrow keys) — not by a physical position. "Link" between cases now syncs **axis + frame index**, not axis + mm. This is simpler and matches how Sem actually uses CFD-Tool (step through frames one at a time, not "jump to X mm").

`PressureDistributions/` CSVs (e.g. `001_pd_FW_x-Section_2500mm.csv`) are confirmed to have headers (`... Direction [0,1,0] (mm)`, `... Pressure Coefficient`) but the one sample supplied had **no data rows**. Do not build CSV plotting yet — wait for one populated CSV.

## Coefficients summary (confirmed, implemented)

Each case's `plots/` subfolder contains a `Coefficients*.csv` (e.g. `Coefficients_49.csv`): one row per solver iteration, columns are the CzA/CxA component monitors (Front%, FW, UT, RW, Mono, Remaining, etc.). The app reads the **last row** (most-converged iteration) as that case's summary and shows it in a table above the panels — one row per loaded case, columns matching CFD-Tool's home screen (`CzA Front(%)`, `CzA`, `CzA FW`, `CzA UT`, `CzA RW`, `CzA MO`, `CzA Rem`, `CxA`, `CxA FW`, `CxA UT`, `CxA RW`, `CxA Mono`, `CxA Rem`).

## Product stages (agreed)

| Stage | Meaning |
| --- | --- |
| 0 | Reverse-engineer STAR-CCM+ → folders → CFD-Tool |
| 1 | Design screens (cases, field, section, viewer, plots) |
| 2 | Tiny app: open → select a case → see it |
| 3 | Single-case-first, grows to 4-panel flexible comparison (see below) |
| 4 | CSV pressure plots (blocked on a populated sample CSV) |
| 5 | FSAE-specific aerodynamic comparison |
| 6 | Interactive CFD fields (VTK / 3D), not only PNGs |
| 7 | Fritz: submit, monitor, download, delete |

**V1 = modern CFD-Tool** (PNG + CSV + 4-way compare). Do not start with a generic ParaView clone.

### Stage 3, revised again: single case by default, panels grow with cases loaded

Sem's actual workflow (per CFD-Tool) is usually **one case at a time**; multi-view is only for comparing. So instead of a fixed 2×2 grid of 4 panels:

- Sidebar: "Open results folder" (the parent folder holding every case, e.g. `finished`) scans and lists every case subfolder. Case slots A–D each pick from that list (or "Browse…" a one-off folder).
- Main area: **one panel per loaded case, in order** — 1 case = 1 full-size panel, 2 cases = side-by-side, up to 4 = 2×2. No empty/placeholder panels are ever shown. Loading fewer cases must never shrink or crop the image below what's needed to see it — panels resize, but `object-fit: contain` on the image means it shrinks to fit rather than getting cropped.
- Each panel: field (dropdown — a case can have a dozen+ fields, chips didn't fit), axis (chips, only ever X/Y/Z), and frame stepping (prev/next buttons + "Frame N / M", no dropdown, no slider — see filename-convention note above for why there's no position label anymore).
- **Link** (per panel/case, checkbox): synced panels share axis + frame index; field and case stay independent. A case whose field doesn't have the linked axis, or doesn't have enough frames, shows "Section unavailable" rather than a nearest-match guess.
- Click a panel to focus it; left/right arrow keys step the focused panel's frame (ignored while a dropdown/input has focus).
- Do not add 3D/VTK, ParaView-style panning/zooming, or CFD solving in this stage. Preserve the original PNG unmodified.

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
