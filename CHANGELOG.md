# Changelog

User-visible changes, newest first. Detailed reasoning lives in
`CHAT_HISTORY.md`; decisions in `DECISIONS.md`.

## 2026-10-27

### Added
- **Residuals page: CzA and CxA** (totals) per iteration under the residuals, from the same solver log.
- **Highlight rows** in the results table: the ☆ before a simulation's name tints its row (★); click again to remove. Remembered, also in the Δ view.
- **Compare up to 4 simulations** on the Residuals page (**Compare with…**): one line per simulation, one equation at a time (select), and their CzA and CxA. Point at a chart to read every value at that iteration.

### Changed
- **Customize columns:** drag a column by its grip (⠿) instead of the ↑/↓ buttons; with the grip focused, the arrow keys still move it.
- **3D viewer opens about twice as fast:** the 12-million-triangle car of `1016_V4_W` now opens in about 3 s instead of 5–6.5 s (data read straight into memory instead of through a file copy, all geometry files downloaded at once, faster mesh building).

## 2026-10-26

### Added
- **Residuals:** every simulation with a solver log (`resTAURANtS.o…` or any job log with STAR-CCM+'s iteration table) has a **Residuals** entry in the results tree: Continuity, X/Y/Z-momentum, Tke and Sdr on a log scale, every value at the iteration under the mouse. Read from the logs already in each case folder, so it works for old simulations too; no macro change.

### Changed
- Faster field switching in the 3D viewer: it no longer rebuilds the mesh (about 2 s → 0.5–0.8 s on a 12-million-triangle car on the laptop's GPU).
- The table toolbar wraps onto a second line on small screens instead of squeezing the title and filter.

## 2026-10-17

### Added
- **3D viewer: value under the mouse.** Pointing at the car or a streamline shows the field value there, the part and the position (x, y, z in m). The scene is drawn once more into the single pixel under the pointer and read back, so the value is exact even on a 13-million-triangle car.
- **3D viewer: the case's coefficients** in a box at the top right (opened from the results tree): CzA, CxA, L/D, downforce and drag at the results table's speed and density, iteration, and CzA/CxA of the front wing, undertray and rear wing. × hides it.

### Changed
- 3D viewer: **Vortices** and **Streamlines** start unticked.

## 2026-10-15

### Added
- **`starccm/mesh.java` writes `MESHED`** after a successful meshing and save. With the one-line change in `starccm/README.md`, a case's `mesh.sh` starts the solver only then, so a failed meshing never costs a solver run.
- **Replacing the remaining parts:** a CAD/STL file whose name contains `replace` and no group word (e.g. `remaining_replace_v2.stl`) now replaces everything in `z_000_remaining-parts`; other files are still added to that group as before.

## 2026-10-14

### Changed
- **`starccm/mesh.java`: STL files without the CAD Exchange licence.** STL files in the case folder are now read with STAR-CCM+'s own STL reader, in millimetres, so they need no extra licence. STEP and IGES still need CAD Exchange, which on Fritz is shared and not always free (on 2026-10-14 it was not). After each import the log lists what the part group contains.
- **A failed CAD import now stops the meshing** (reason in `ERRORS` and the log) instead of meshing and solving with the old parts. `starccm/README.md` shows a one-line change for a case's own `mesh.sh` so the solver is not even submitted then.

### Added
- **Import-only test:** an empty `IMPORT_ONLY` file in the case folder makes `mesh.java` import the CAD files, log the result and stop without meshing or saving.

## 2026-10-14

### Added
- **Sharing through SVN:** `py tools/make_portable.py --into <folder>` writes the unpacked app (with its Python) into a folder, e.g. the team's SVN `…\1_Aero\HOMO-CFD`: new and changed files only, nothing deleted, leftovers listed for the commit dialog. Teammates run HoMo CFD from their SVN checkout and get updates with **SVN Update**. The README explains both sides.

### Changed
- The builds (zip and SVN) ship a teammates' guide as `README.md` (`docs/APP_README.md`: start, first start, SVN updates, what's where) instead of the project README with its developer notes.
- HoMo CFD no longer writes Python's `__pycache__` into its own folder, so a shared (SVN) folder stays unchanged while it runs.

## 2026-10-13

### Added
- **Results on Fritz** in the Fritz cluster page: under Simulations on Fritz, a table of every case's last coefficients on Fritz (iteration, CzA, CxA, L/D, downforce and drag at the results table's speed, CzA/CxA of front wing, undertray and rear wing), so results can be checked before downloading and without WinSCP. It comes with the same Refresh (one read-only login).
- **Parts in the Fritz table:** CzA and CxA of the front wing, undertray and rear wing. The table now fits the window: totals, then forces, then the parts, each group added while case names keep 30 characters; `ht -p` (`--parts`) puts the parts first (on a phone: only the parts). `--sort fw`, `ut` or `rw` puts the most downforce of that part first. Fixed: a "solve?" state shifted its line by one character. The table also shows the last iteration (Iter) after the state. Copy the new `fritz/homo-table.py` to Fritz to use it.

## 2026-10-10

### Fixed
- **Slow start with results on a hard disk:** HoMo CFD keeps a copy of the results folder's listing in its settings folder and opens from it at once; the folder is scanned in the background and the page updates by itself if a simulation was added or removed. Before, every start waited for the scan, 7–15 s on a hard disk once Windows had dropped the folder data from memory (~400 folders, ~50,000 files).

### Added
- **Results table on Fritz for the phone:** `fritz/homo-table.py` prints the table in a terminal on Fritz (e.g. Termius): state, CzA, CxA, L/D, and on wider screens downforce and drag in N at each case's own speed. Sort with `--sort downforce|drag|ld|name|time`; one case in detail with its name. Read-only, Python 3.6+, nothing to install; setup in `fritz/README.md`. Included in the portable zip.

## 2026-10-09

### Added
- **`starccm/mesh.java`: new parts from CAD files.** The team's meshing macro, with a reworked CAD import: STEP/IGES/STL files in the case folder replace the front wing, undertray, deflectors, monocoque or rear wing by name (`frontwing` or `FW`, `undertray` or `UT`, `deflector`, `mono`, `rearwing` or `RW`), assemblies with many bodies work, and a failing file is reported in `ERRORS` without stopping the others. Compiled against STAR-CCM+ 2506; not yet run on Fritz.

## 2026-10-08

### Added
- **STAR-CCM+ colormaps in the 3D viewer:** FAU-bwr, HiVo Transparent, turbo and blue-red balanced from the team's `maps.colormap`, in their own group under **Palette**, with their colours at the same positions as in STAR-CCM+ (without its transparency).

## 2026-10-07

### Fixed
- **3D viewer on smaller screens:** the toolbar wraps to a further row instead of pushing Auto range and Reset view off screen (seen on a laptop with display scaling), and labels stay on one line.

### Added
- **Palettes in the 3D viewer:** **Palette** in the toolbar: Rainbow (as before), STAR-CCM+ (blue–red), Cool–warm, Viridis, Inferno, Grey, Magenta–gold. Surfaces, streamlines and the legend bar follow it; the choice is remembered.

### Changed
- 3D viewer: the line listing the folder and all parts under the title is gone; the window title names the simulation instead (e.g. "1002_homo_test · 3D viewer").
- **Fewer instruction texts** (user review): no mouse/key help in the 3D viewer, no key hints in the image and scene windows (path and scene count stay) or the pressure plot (only the station, e.g. "2460 mm"), the Δ note is one line ("Δ = simulation − reference"), no explanation under the monitor chart title or in Customize columns. **Choose working directory** now says to create a results folder with **finished** and **inProgress** inside, without referring to CFD-Tool.

### Removed
- The hint line under the **Simulation comparison** title ("Each panel has independent field, axis, frame, and zoom controls. T: CpT · …").

### Added
- **Thicker streamlines:** **Thickness** in the streamline bar (Thin, 2, 3, 4 or 6 px; 2 px by default, remembered).
## 2026-10-06

### Added
- **Sort the coefficient table:** click a column header to sort the simulations by it (▲ ascending), again for descending (▼), a third time for the original order. **Simulation** sorts by name; in **Δ vs reference** the rows sort by the difference. Empty cells always go last. The choice is remembered.
- **Streamlines in the 3D viewer:** `starccm/export3D.java` now also writes `<sim>_streamlines.case`. The streamlines start 5 cm in front of the car, in 20 rows over its height with 40 start points across its width (800 lines), and are traced downstream with the flow fields. The viewer draws them as lines coloured by the selected field, up to 1 m behind the car, with a **Streamlines** checkbox (on). Rows and points per row can be set in the case's `Settings`. Tested on Fritz.
- **Choosing streamlines:** a bar under the 3D viewer's toolbar shows **Lines** (all, every 2nd, 3rd or 4th row and line), a **Height** and **Width** range for where the lines start (in m; empty = no limit), **All positions** and how many lines are shown, e.g. "200 of 800 lines". The choice is remembered.
- **Surface flow (like oil flow):** the export adds the wall shear stress direction (`WallShearStressX/Y/Z`) to the car. The viewer's **Surface flow** checkbox (off at first) draws short lines along the surface in the direction the air moves, dark at the downstream end, so separation and reversed flow show up.

### Fixed
- An empty cell in the coefficient table counted as 0 in **Δ vs reference** and the monitor chart; it now counts as no value.
- Streamlines started at the nose instead of 5 cm in front of it, because the simulation measures in mm; the macro now works in metres.
- Streamlines were grey for every field: STAR-CCM+ writes their values per point (padded with zeros of varying length, a late piece of line sometimes further on), which the viewer now reads. A folder with such a file no longer stops with "Field values for … cells do not match part Streamlines 1".

### Changed
- 3D viewer: one checkbox per kind of part (Vortices, Streamlines, Bad cells), and the view is fitted to the surfaces only.

## 2026-10-02

### Added
- **About HoMo CFD:** `ABOUT.txt` (version 1.0, purpose, maker Archit Paneliya with contact archit.paneliya@voltages.de, the AI assistants used, how to start and stop) is in the portable zip and shown by the new **ⓘ** button at the bottom of the sidebar; the README names the maker.
- **HoMo CFD icon:** an inverted wing profile with flow lines, in the browser tabs of all windows (`web/favicon.svg`, `web/homo-cfd.ico`) and on a desktop shortcut: `Create desktop shortcut.bat` (also in the portable zip) puts a **HoMo CFD** shortcut on the desktop that starts HoMo CFD.
- **"Post-processing failed"** in Simulations on Fritz: when the newest post log has an uncaught macro error (a Java exception at the start of a line, or a macro compile error), the case shows in red instead of "Ready to download" and offers **Download anyway**. Errors the 3D export catches itself don't count. A case with a post log now counts as post-processing even without solver logs (test folders set up by hand).
- **3D export installed in `SCRIPT_RANS`** (previous macro kept as `postprocessing.java.bak`). `export3D.java` writes the car (`<sim>.case`, 10 fields) and the Lambda2/Bad_Cells parts (`<sim>_flow.case`, flow fields only) as two exports; the 3D viewer reads all `.case` files of a `3D-data` folder as one model.
- **More 3D data:** `starccm/export3D.java` now also exports skin friction coefficient, y+, and the magnitudes of wall shear stress, velocity and vorticity, plus the simulation's `Lambda2` part (vortex cores, iso-surface of neg(Lambda2)) and `Bad_Cells` part, and a `fields.txt` list of all field functions. It finds `CpZ-CpX` (missed before) and skips the `Cells deleted from …` regions. Not yet run in STAR-CCM+.
- **3D viewer:** **Vortices (λ2)** and **Bad cells** checkboxes when the export contains those parts (Vortices on, Bad cells off); each field keeps its own colour range (a range you set or Auto range is remembered per field; Cp fields start at −5…1, other fields at their 1st–99th percentile); field names with spaces are read from the `.case` file.
- **Automatic 3D data from STAR-CCM+:** `starccm/export3D.java` exports the car's wall surfaces with PressureCoefficient, TotalPressureCoefficient, CpX, CpZ and CpZCpX per cell into `3D-data/` (EnSight Gold, about 70 MB for a full car plus about 6 MB per field), skipping the wind-tunnel boundaries and interfaces. Played by a small, fail-safe addition to the team's `postprocessing.java`, which is now in the repo as `starccm/postprocessing.java` (the `SCRIPT_RANS` version of 2026-10-02 plus that call; copy both files into the template, see `starccm/README.md`), so every new case can be opened in the 3D viewer after downloading. Tested on Fritz: a full car in about 100 MB, opened in the 3D viewer.
- **Portable version for teammates:** `py tools/make_portable.py` builds `dist/HoMo-CFD-portable.zip` (about 13 MB) with HoMo CFD and its own Python 3.14.8 (Windows embeddable package from python.org, SHA-256 checked). Unzip and double-click `Start HoMo CFD.bat`; nothing to install. The start script uses the bundled Python when present, and **Browse…** works without tkinter through the Windows dialogs (PowerShell).
- **3D viewer orientation:** axes widget (bottom left; click an axis end to look along it), four angled 3D views (front-left, front-right, rear-left, rear-right) and car-named axis views (Front / Rear / Left side / Right side / Top / Bottom, with the axis), each fitted to the window, plus a **Shading** option that lights the surface for depth.
- **New simulation on Fritz** (Stage 7, steps 3–4; in the Fritz cluster card): name, Settings loaded from the team template (`SCRIPT_FABSI`) or an existing case and edited in a form (changes highlighted), base `.sim` from this computer (Browse…). **Create on Fritz** copies the template into a new folder only if the name is free, then uploads Settings and the `.sim`. **Start** (for cases not started yet) runs `sbatch mesh.sh` through a second WinSCP session to a Fritz login node, after a confirmation, and never twice. The case list shows live job states (Queued / Running with elapsed time and job number) from that session.
- **Simulations on Fritz** (Stage 7, step 2; in the Fritz cluster card): every case folder in your remote folder with its state (Not started, Meshing, Solving, Post-processing, Ready to download), the time of its last job log, whether it is already on this computer, and "probably stopped" when an unfinished case has had no log update for 12 h. **Download** fetches a case into `inProgress` and moves it to `finished` when complete (resumable, with progress and Cancel; skips job scripts, macros and `.sim~`; `.sim` files only when ticked). Refreshes every 5 minutes while open. Nothing on Fritz is changed or deleted.
- **Fritz cluster** settings (Stage 7, step 1; sidebar, with `serve.py` only): choose your WinSCP saved session and the remote folder, **Test connection** (logs in and shows the folder; nothing is uploaded, started or deleted), **Save** (per user in `%APPDATA%\HoMo-CFD\settings.json`; no passwords or keys). **Unlock key with Pageant** starts Pageant with the session's key file when the key has a passphrase; Pageant asks for it in its own window.
- **Downforce [N]** and **Drag [N]** columns right after Iteration: F = ½ · ρ · v² · (−CzA or −CxA) at a speed (km/h) and air density set in the table toolbar (defaults 60 km/h and 1.18415 kg/m³, remembered per browser). Positive = downforce / drag, in values and Δ-vs-reference views; the monitor chart starts on Downforce [N]. CzA and CxA (downforce and drag coefficients × reference area) stay as exported. (Interim sign-flipped −CzA / −CxA columns were added and removed the same day.)
- **L/D** (= CzA ÷ CxA) column after the forces, with hover note and Δ support. (A Balance [% front] column was added and removed the same day; CzA Front stays as exported.)
- **Working directory** like CFD-Tool: chosen once per user (Browse… or paste a path), saved in `%APPDATA%\HoMo-CFD\settings.json`; CFD-Tool's saved working directory is reused automatically; results come from its `finished` folder.
- `serve.py` indexes the results folder: no browser folder picker or permission prompts, works offline in any browser.
- `Start HoMo CFD.bat` double-click launcher.
- `3D-data` folders open the 3D viewer straight from the results tree.
- Comparison window: X/Y/Z axis keys; `+` / `-` / `0` zoom keys (also in the scene gallery); with 3–4 cases each panel keeps at least 420 px height and the window scrolls instead of shrinking images.
- One-click **Reconnect** when a browser-picked folder needs permission again.
- Tests: `tests/test_serve.py` and the headless browser suite `tests/run_browser_tests.py` on generated data.

### Changed
- **No console window:** `Start HoMo CFD.bat` and the desktop shortcut start HoMo CFD in the background (`pythonw`, `serve.py --background`, log in `%APPDATA%\HoMo-CFD\homo-cfd.log`). Stop it with the new **⏻** (Quit) button at the bottom of the sidebar; it also stops 30 minutes after the last window closed (every window reports once a minute), never during a download or upload. If it has stopped, open windows say so.
- The portable build deletes its unpacked folder after writing the zip, so `dist/` holds only the zip and the cached Python download.
- **Sidebar:** the **HoMo CFD** title is now the working-directory button and shows the folder underneath (replaces the separate Working directory button); **3D viewer** and **Cluster** (renamed from Open 3D Cp viewer and Fritz cluster) sit side by side at the bottom of the sidebar and stay visible when the folder tree scrolls.
- Portable zip for teammates: now includes the STAR-CCM+ macros (`starccm/`, with instructions for their own template) and no longer the changelog; `starccm/README.md` rewritten for teammates.
- **Faster image viewer (speed over memory):** the first image shows as soon as it is read; the rest of the sequence loads in the background and stays loaded, so stepping back and forth or holding an arrow key doesn't wait again, and switching back to a field or axis is instant. The comparison window lists a case in one request instead of one per section folder; single folders and the 3D scene gallery no longer read every image before showing the first. Measured on a real case: 45 ms per step instead of 75 ms, 3D scene gallery open in 0.42 s instead of 0.81 s.
- **3D viewer rotation is a turntable:** dragging sideways turns the car around its vertical axis, dragging up/down tilts the view (stops at straight above/below), so the car never tumbles or tips over. The wheel zooms towards the pointer; arrow keys turn 15°; Home resets; Shift+drag also moves. View changes are animated.
- No more flicker when stepping through images: the comparison window swaps the image inside each panel (already sized, zoomed position kept) instead of rebuilding the panels, and the single-folder / scene gallery view keeps the current image until the next one is decoded (neighbours are decoded ahead).
- The image viewer shows no scroll bars: move zoomed images by dragging, zoom with the wheel or `+` / `-`; with 3–4 cases the window still scrolls with the wheel over a panel header or caption.
- The table toolbar is hidden behind the working-directory and cluster cards, a table that finishes loading no longer replaces an open card, and the cards' inputs use the dark theme.
- Faster start-up with many simulations: 120 simulations load in about 4 s (was 5.7 s).

### Fixed
- Fritz: logging in failed when a WinSCP session's own local folder no longer existed (WinSCP stops the script at login). HoMo CFD now always logs in with the temp folder as local folder; it only uses full paths anyway. This affected the fritz session (Start, job list) after a project folder was removed.
- 3D viewer: field files that leave parts out (STAR-CCM+ does this for small wall pieces split off at interfaces) stopped loading with "Expected Cp for part …"; values are now read by part number and cells without values show grey.
- 3D viewer: a part without points (an empty boundary, e.g. the other side's wheel in a half-car export) no longer stops loading; empty parts are left out of the part list.
- The 3D viewer showed a mirror image (left and right swapped) because of a wrong depth sign; views are now true rotations (checked in the browser tests).
- **Create on Fritz** failed with "Fritz refused the login": its shell command needed a second login, which NHR's jump host sometimes turns away. A new simulation is now created in one login with WinSCP's own commands only (the template's files are copied through a temporary folder on this computer, never a `.sim`), and WinSCP's `mkdir` stops everything if the name exists. Messages now say whether anything was changed on Fritz.
- **Session for starting jobs**: choosing the jump-host session (csnhr, no SLURM) now shows a warning under the field that names your fritz session; Test connection explains the same instead of "Could not reach Fritz", and a refused connection says to wait a minute and try again.
- Choosing a single simulation folder as the results root broke image sections and named the simulation "plots".
- Simulations nested below the results root were missing from Add case and pressure overlays.
- Pressure overlays silently mixed stations; off-station cases and scene images are now labelled. Missing x-axis label and "undefined" chart title.
- Unreadable coefficient files disappeared silently; they are now listed.
- Comparison window memory grew with every visited frame; held arrow keys could skip or step backwards; errors were only in the console.
- Scene gallery zoom could not reach the image edges.
- 3D viewer: NaN cell values, reversed colour range, legend rounding, fast field switching; the triangle count showed three times the real number.
- Server refused some requests during bursts (pressure stations) on Windows.
- `.git` and other hidden folders were indexed.

### Docs
- `docs/STAGE7_FRITZ.md`: how CFD-Tool talks to Fritz and a proposed design for Stage 7 (draft for review).
- `DECISIONS.md`, `TASK.md`, `CHANGELOG.md`, `tests/README.md`; refreshed `HANDOFF_FOR_CHATGPT.md`.

### Removed
- **About button (ⓘ)** and its About dialog, at the user's request. `ABOUT.txt` stays in the portable zip and the README still names the maker.
- About 700 lines of unused legacy slot-UI code.
