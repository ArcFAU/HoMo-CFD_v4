# Changelog

User-visible changes, newest first. Detailed reasoning lives in
`CHAT_HISTORY.md`; decisions in `DECISIONS.md`.

## 2026-10-02

### Added
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
- **3D viewer rotation is a turntable:** dragging sideways turns the car around its vertical axis, dragging up/down tilts the view (stops at straight above/below), so the car never tumbles or tips over. The wheel zooms towards the pointer; arrow keys turn 15°; Home resets; Shift+drag also moves. View changes are animated.
- No more flicker when stepping through images: the comparison window swaps the image inside each panel (already sized, zoomed position kept) instead of rebuilding the panels, and the single-folder / scene gallery view keeps the current image until the next one is decoded (neighbours are decoded ahead).
- The image viewer shows no scroll bars: move zoomed images by dragging, zoom with the wheel or `+` / `-`; with 3–4 cases the window still scrolls with the wheel over a panel header or caption.
- The table toolbar is hidden behind the working-directory and cluster cards, a table that finishes loading no longer replaces an open card, and the cards' inputs use the dark theme.
- Faster start-up with many simulations: 120 simulations load in about 4 s (was 5.7 s).

### Fixed
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
- About 700 lines of unused legacy slot-UI code.
