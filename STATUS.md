Last updated: 2026-10-02

## Done

- The landing view is a searchable filesystem tree. The chosen results-root handle is stored in IndexedDB and restored when browser permission remains granted; otherwise the sidebar shows a one-click **Reconnect** button. Hidden folders (for example `.git`) are skipped during indexing. The root may be a single simulation folder, a folder of simulations, or a tree with simulations nested deeper; every simulation at any depth is offered in comparison windows and pressure overlays.
- The workspace displays only one collective table: the final data row from each `Coefficients*.csv`, one row per simulation. Coefficient values display to three decimal places and the iteration number as an integer. No other CSV tables or full coefficient histories are rendered.
- Stage 5 has **Values / Δ vs reference** modes in the coefficient table plus a collapsible raw-monitor comparison chart. Deltas are signed case-minus-reference by original monitor header; the reference row is zero. Since 2026-10-02 the table also shows computed **Downforce [N]** and **Drag [N]** right after Iteration, = ½ · ρ · v² · (−CzA / −CxA) at the speed and air density set in the table toolbar (defaults 60 km/h, 1.18415 kg/m³; remembered per browser). CzA/CxA are the downforce/drag coefficients × reference area; negative means downforce/drag, so the forces are positive and a positive Δ means more downforce/drag than the reference. The monitor chart starts on Downforce [N]. **L/D** (= CzA ÷ CxA, 2 decimals) follows. Exported monitors and the CzA Front fraction are unchanged.
- **Customize columns** allows renaming, hiding, and reordering coefficient columns. Preferences persist in browser local storage; values remain bound to original CSV headers.
- CSV discovery covers section-like folders even when they also contain images. Actual image files are not read during root indexing.
- Clicking an image section opens a comparison window seeded with that simulation and selected field/axis; **Add case** inside the window adds more simulations. The main window has no comparison case slots.
- Each panel has independent field, axis, and frame controls; zoom and normalized pan are always synchronized without UI toggles. Left/right keys step the focused panel unless optional **Sync images** is enabled.
- In the comparison scene window, T/V/P/L switch the focused panel to CpT/Velocity/Cp/Lambda2 when that field exists; the current axis is kept when available and the frame resets to the first image.
- In the comparison window, X/Y/Z switch the focused panel's axis when that axis exists for its field and reset to the first image; they also work while a field dropdown is focused. (The earlier main-page X/Y/Z handling belonged to the retired slot UI and was removed with it on 2026-10-02.)
- A populated pressure-distribution sample is available in `0830_mk3/PressureDistributions`: six FW/UT/RW x/y groups with coordinate and pressure-coefficient columns. Empty station files are present and must be skipped by plot rendering; pressure plotting is now unblocked.
- Browser-tested against the supplied data using in-memory file handles: FW/X at 2420 mm rendered 1,783 measurements. The EnSight Frontwing case rendered 593,500 triangles (first reported as 1,780,500: the viewer label counted triangle corners; fixed 2026-10-02), exposed all five fields, and CpZ Auto range matched the data limits −3.319…+2.135. The native directory picker/permission flow was not exercised end-to-end.
- Pressure-distribution group folders open their matching plot in an immersive workspace that hides the folder tree. Up to four cases overlay in distinct colors, with separate pressure-side and suction-side colors; positive Cp plots down and negative Cp up. Stations follow front-to-back file order and are stepped with keyboard arrows (no position dropdown). Optional Cp/Velocity/CpT/Lambda2 images stay linked to that pressure plane; one image gets the larger view, two stack vertically, and three/four use a two-by-two layout. Image labels and gaps are removed to maximize plot and image area.
- Zoom uses explicit fit-relative dimensions inside scrollable image stages rather than CSS transforms, so enlarged images remain fully reachable. Zoom changes preserve the viewport center; reset returns all panels to fit. The 3D scene gallery uses the same scrollable zoom with drag-pan.
- Image sequences are indexed without eagerly reading every file; frames within ±2 of the current one are decoded and kept, and farther frames are released so memory stays bounded. Removing or replacing a case releases its images. Viewer actions (arrow keys, field/axis/case changes) run one at a time; held arrow keys skip repeats while an image loads, and load errors appear in the viewer instead of only the console. A real Cp/X sequence opened with its first image ready in about 0.8 seconds; the next-frame step measured about 11 ms.
- Browser-checked against the remembered `finished` folder: the table contains seven simulation rows and only one rendered table; the first simulation's final iteration is `1000.0`. Opening a real image seeded a one-case comparison; adding a second simulation allowed independent Cp/Y and Velocity/X panels at full resolution.
- Browser-checked Stage 5 with the real `finished` root: seven coefficient rows, zero baseline row, seven chart bars for the selected monitor, and return to the single Values table. Monitor chart labels explicitly avoid interpreting sign as aerodynamic benefit.

## 2026-10-02 problem-list fixes

- Removed about 700 lines of unused legacy slot-UI code from `web/app.js`.
- Pressure overlays: a case without data at the plotted station is drawn from its nearest station and labelled `name @ station mm` in the legend, with a note under the chart. Scene images are matched by mm station only; an image whose plane differs from the plot shows a small caption, and images without a station in the filename are not shown. The x-axis label comes from the CSV coordinate header.
- Coefficient files that cannot be read are listed in a notice above the table instead of disappearing silently.
- Viewer hand-off entries in IndexedDB are timestamped and pruned after 24 hours when the main window starts.
- 3D viewer: non-finite cell values are ignored when averaging onto points (points with no finite value render grey); reversed Range min/max are applied swapped and flagged; the legend shows limits to three decimals; only the latest field request updates the mesh.
- Verified with a headless-Chrome harness using mock folder handles over the real `0830_mk3` files (single-simulation root, several simulations with an unreadable CSV and a hidden folder, nested simulations, reconnect, 3D Frontwing): 35/35 checks passed on three of four runs; one earlier run missed a pressure-legend check once (not reproduced). The native folder picker and real permission prompts were not exercised.

## Working directory, CFD-Tool style (2026-10-02)

- CFD-Tool (inspected read-only: `Config.class` via `javap`, no execution) stores one per-user working directory in `%APPDATA%\CFD-Tool\resources\workingDir` (here `D:\CFD_tool`), asks with a "Choose Working Directory" dialog on first start, and reads results from `<working dir>\finished`.
- HoMo CFD now does the same: `serve.py` uses `--working-dir` (one run), else `%APPDATA%\HoMo-CFD\settings.json`, else CFD-Tool's saved working directory, else the app shows **Choose working directory** (Browse… opens a native folder dialog through tkinter; a pasted path also works). Results come from `finished` inside it when present. The sidebar **Working directory** button changes it. `Start HoMo CFD.bat` starts everything with a double-click; a second start just opens the browser. Fully offline; no external URLs in `web/`.
- Safety: API answers only requests addressed to 127.0.0.1/localhost (Host check), settings changes require a JSON POST (blocks cross-site requests), working directory must be an existing absolute folder. Listen backlog raised to 128 after bursts of station-file requests were refused on Windows.
- The earlier `homo-cfd.config.json` / `--results` approach was replaced (`--results` still works as an alias).
- Verified: precedence and validation with a temporary APPDATA (fresh user → chooser; saved setting reused after restart; CFD-Tool-only → `D:\CFD_tool\finished`; missing/relative path 400; foreign Host 403; form POST 415; second start exits cleanly); headless first-start flow 8/8; end-to-end 12/12; browser-folder suite 35/35 three times. Not exercised: the tkinter Browse dialog and the batch file (both open windows on the desktop).
- Read-only API: `/api/config`, `/api/tree` (whole folder tree in one request), `/api/list`, `/api/file` (with Last-Modified/304). Bound to 127.0.0.1; rejects `..`, drive letters, backslashes and hidden entries. `web/server-fs.js` wraps it in File System Access-style handles, revived after IndexedDB hand-off to viewer windows.
- `3D-data` folders containing a `.case` file appear in the tree as **3D-data · 3D viewer** and open the 3D viewer without a picker.
- Indexing uses `os.scandir`: two linked copies of `0830_mk3` scan in about 0.025 s (was 1.5 s with `Path.iterdir`).
- Verified: API probes (traversal and hidden paths return 400; conditional GET returns 304); headless-Chrome end-to-end run against the real server with two junction-linked `0830_mk3` cases, 12/12 checks (auto-load, comparison window and stepping, pressure plot, scene gallery, 3D viewer from tree); browser-folder regression suite still 35/35. Not yet tried with the user's real `finished` folder.

## Viewer, Stage 5 and tests (2026-10-02, overnight)

- Comparison window layout is CSS-driven per case count: 1 = full, 2 = side by side, 3-4 = 2 x 2 with each panel at least 420 px tall; the window scrolls rather than shrinking images. Below 1000 px width, panels stack in one column.
- `+` / `-` / `0` zoom in, out and reset in the comparison window and the scene gallery.
- Stage 5 Downforce [N] / Drag [N] columns (see above), with hover explanations and sign-aware notes in the Δ view and monitor chart.
- 3D viewer triangle count fixed (it showed index count = 3 x triangles).
- Tests in the repo: `tests/test_serve.py` (15 unit tests) and `tests/run_browser_tests.py` (67 headless checks over generated data in `tests/fixture.py`). See `tests/README.md`; `AGENTS.md` asks every contributor to run them.
- Planning files from the ChatGPT pipeline: `DECISIONS.md`, `TASK.md`, `CHANGELOG.md`.
- Scale check: 120 simulations (junctions to the 7 real ones in `D:\CFD_tool\finished`, about 200,000 files) load in about 4 s (server scan about 1.2 s, 15.8 MB listing, browser indexing about 0.6 s, coefficient files about 0.3 s). Was 5.7 s before indexing read each folder once and used one shared `Intl.Collator`. A multi-threaded server scan was slower (2.4 s) and was not adopted.

## Stage 7 step 1: Fritz connection (2026-10-02)

- `cluster.py` (stdlib): finds `WinSCP.com`, lists WinSCP saved-session names from the registry (`Default Settings` excluded), checks inputs (no quotes or control characters; remote folder must start with `/` or `~`), and runs WinSCP scripts with `/nointeractiveinput` and a temporary `/script=` file (90 s timeout, deleted afterwards). The test script is `open` + optional `cd` + `pwd` + `exit`: read-only.
- `serve.py`: `GET /api/cluster` → `{winscp, sessions, session, remoteFolder}`; `POST /api/cluster` saves `{session, remoteFolder}` under `cluster` in `settings.json` (keeps `workingDir`); `POST /api/cluster/test` runs the test (one at a time) and returns `{ok, remoteFolder | error, hint, output}`. Same local-host and JSON-only protections as the other API calls. Tests swap `Handler.winscp` for a fake.
- App: **Fritz cluster** sidebar button (server mode only) opens a card with WinSCP status, session dropdown (text field when no sessions are found), remote folder, **Test connection**, **Save**, and the WinSCP output in a collapsible box. Known WinSCP failures get a plain hint (host key not cached, login refused, passphrase/password needed, folder missing, no such session, network).
- Checked on this PC without contacting Fritz: real `WinSCP.com` found and runs a script (exit 0; errors give 1); 2 saved sessions found (names not read).
- First real test (user, 2026-10-02): Fritz was reached, but login stopped because the session's key has a **passphrase** (`/nointeractiveinput` correctly prevented a hidden prompt). Added Pageant support: `GET /api/cluster` reports `pageant {found, running}`; `POST /api/cluster/pageant {session}` starts `pageant.exe <session's key file>` (key file from the session's `PublicKeyFile` registry value; PuTTY's or WinSCP's own Pageant), and Pageant asks for the passphrase in its own window. The passphrase hint now comes first and the test result has `needsPassphrase`. Next: the user unlocks the key with Pageant and tests again.

## Open items

- Stage 7 (Fritz): design draft in `docs/STAGE7_FRITZ.md`, based on how CFD-Tool uploads with WinSCP + PuTTY key, runs `Pipeline/launchV3.sh`, polls `plots/DONE`, and moves cases inProgress → finished. Decided 2026-10-02 (doc sections 4–5): WinSCP saved sessions, own Fritz account per user, submit with `sbatch mesh.sh` (no `launchV3.sh` found), HoMo CFD writes the job scripts and `post.sh` ends with `plots/POST_DONE`, download after post-processing, never delete on Fritz, licence key per user in local settings. Build order: connection + test, monitor/download, job scripts, submit.

- The actual `High-Voltage_white.png` logo is present at the project root and is used in the main-window header.
- Pop-ups must be allowed for http://127.0.0.1:5173. With `serve.py` any modern browser works; only the fallback without `serve.py` (Open folder) needs Chrome or Edge.
- Later 3D viewer improvements: add an orientation axis widget and additional angled view presets. These are deferred; the user has confirmed the signed-axis view fix works.
- Later 3D viewer improvement: part-level show/hide controls. Deferred because the user considers the full-car rendering sufficient for now.
- Note 2026-10-02: the saved working directory on the user's PC is `D:\CFD_tool\finished` (probably from trying **Browse…**). For Stage 7 it should be `D:\CFD_tool`, the folder that also holds `inProgress`.
- User check 2026-10-02: `Start HoMo CFD.bat` opens the browser and everything looks good. **Working directory → Browse…** was not mentioned separately; confirm when convenient.
- Later improvement (distribution, decided 2026-10-02): for now teammates install Python 3 themselves. Later, bundle a portable Python with HoMo CFD so it is unzip-and-run like CFD-Tool, which shipped its own Java runtime.
- Stage 5: sign convention confirmed by the team (negative CzA = downforce, negative CxA = drag, CzA Front is a fraction); Downforce [N] / Drag [N] columns added (the interim −CzA / −CxA columns were removed at the user's request); L/D added on request (a Balance [% front] column was removed again at the user's request). Further derived metrics (component forces, balance from components) only on request.
- `.gitignore` now excludes the 1.75 GiB local result tree and both ZIP archives. `CFD-Tool.zip` contains a possible `p.ppk`; it was not extracted or inspected and remains ignored.

## How to run

Double-click `Start HoMo CFD.bat` (or `py serve.py --open`). The app opens at http://127.0.0.1:5173 and uses the saved working directory (CFD-Tool's on this PC: `D:\CFD_tool`). See `README.md` for first-start setup.

## Recent pressure plot refinement

- Scatter points distinguish up to four cases by circle, square, triangle, or diamond markers. The legend repeats each symbol while preserving separate pressure-side and suction-side colors.

## Interactive 3D Cp preview

- The main window has an **Open 3D Cp viewer** action that opens a separate full-window workspace.
- The viewer reads the EnSight Gold `.case`, geometry, and per-element scalar files from a selected `3D-data` folder. It triangulates `tria3`, `quad4`, and `nsided` surface cells; scalar values are averaged onto shared points for an efficient WebGL2 mesh.
- The preview includes field selection, editable Cp color limits (default range −5 to +1), an **Auto range** action based on finite values of rendered surface cells, drag rotation, wheel zoom, right-drag pan, isometric reset, and signed-axis orthographic view presets (+/−X, +/−Y, +/−Z).
- Initial framing and the low-Cp colors were refined after the first user screenshot: the camera fit uses only vertices referenced by rendered surface cells (excluding unused points), starts closer, and uses a brighter blue-to-red scale.
- It is a surface preview only. Volume visualization, cut planes, exact per-cell flat coloring, and broader format compatibility are not implemented yet.
- The user supplied a screenshot confirming the initial implementation loaded the sample (10 parts, 153,325 triangles); the screenshot showed a small, dim surface. The framing/color refinement has not yet been rechecked in that browser. No tests were added or run.

### Earlier 3D-data volume export (superseded by the Frontwing export below)

- `UPSI_CFD_BASE_0823_surface.test2.case` declares three node scalars: `CpX`, `CpZ`, and `CpZCpX`, all at one time step.
- The three scalar files are about 13 MB each and their headers identify EnSight part ID 2. The geometry file is about 4.58 GB; its first part is `Air` (ID 1), with about 50.2 million nodes and volume element groups including `tetra4` and `nfaced`.
- This is a volume/domain export rather than a small vehicle-only surface export. The current viewer is incompatible: it expects a per-element scalar and loads the full geometry into one browser `ArrayBuffer`; it also does not render volume `nfaced` cells.
- The fields could be useful for a surface display if geometry part 2 is the intended vehicle surface, but that mapping and the meanings of CpX/CpZ/CpZCpX are not documented in the files inspected. Recommended input for the current viewer is a reduced surface-only export of the intended vehicle parts with matching fields. A streaming, part-selective EnSight reader would be a larger alternative.
- Inspected the case descriptor, each field header, geometry header/first part and selected geometry records using file seeks; did not load or alter the 4.58 GB file. No tests run.

### Current Frontwing surface export

- `0830_mk3/3D-data/UPSI_CFD_BASE_0823.case` references binary EnSight Frontwing geometry and five per-element fields: `CpX`, `CpZ`, `CpZCpX`, `PressureCoefficient`, and `TotalPressureCoefficient`.
- Geometry is 7,769,296 bytes, with part 1 named `Frontwing`, 297,923 nodes, 221 `tria3` cells, 3,793 `quad4` cells, and 148,934 `nsided` cells (152,948 total). Each field file is 612,196 bytes and contains matching `tria3`, `quad4`, and `nsided` value blocks ending at the expected file boundary.
- Updated `web/3d-viewer.js` to triangulate `nsided` polygons and select among the per-element scalar fields listed in the case. Geometry and field file sizes are manageable for the local browser reader.
- The file structures and value block offsets were inspected; browser rendering and field switching have not been verified. No tests were added or run.
- A follow-up inventory on 2026-09-30 found only this Frontwing EnSight case in the workspace's `3D-data` folder. To advance the 3D viewer to another vehicle component, add an undertray or rear-wing export with surface-only geometry and matching per-element scalar files. The current loader iterates all geometry parts in a case, so an additional part or a separate component case can use the same format; verify any added export visually before engineering use.
- User confirmed in the browser that a selected export displays the entire car. Their screenshot shows Frontwing, monocoque (`mono`), Rearwing, Remaining, Undertray, front/rear wheels, rims, and suspension together with the PressureCoefficient field. The full-car export is considered to work for now; do not block further work on re-exporting it. The workspace's sample `0830_mk3/3D-data` is still the smaller Frontwing case used for local file inspection.
- Part visibility controls (show/hide individual geometry parts) are deferred to later improvements. The user considers the current full-car view sufficient for now.
- Numeric scan of all 152,948 cells in the local Frontwing files: `CpX` ranges −2.751 to +2.343; `CpZ` −3.319 to +2.135; `CpZCpX` −4.507 to +2.957; `PressureCoefficient` and `TotalPressureCoefficient` each −3.720 to +1.305. The current displayed range −5 to +1 clips positive values above +1 in every field. These are measured file ranges, not STAR-CCM+ visual/engineering validation.

### Additional `0830_mk3` data available for future work

- `3D/` contains 21 static reference scenes: Cp, CpT, Cp X, Cp Z, Cp Z − Cp X, SFC, and SFC flow pattern across X/Y/Z where supplied. The filesystem tree now exposes image-bearing folders named `3D` as a **3D scenes** entry. It opens a dedicated image window with naturally sorted filenames and left/right arrow-key stepping; scene images are not read during results-tree indexing.
- Image sequences are present for Cp, CpT, and Velocity on X/Y/Z sections (150 X, 80 Y, 220 Z frames per field), plus 150 Lambda2 X frames. These match the existing image-sequence workflow.
- `PressureDistributions/` contains 690 CSVs across the six FW/UT/RW X/Y groups (150 X and 80 Y files per group), and `plots/Coefficients_49.csv` contains per-iteration component monitor histories. The app already has pressure-distribution and final-coefficient workflows for these formats.
- Root-level `Settings`, Java macros, shell scripts, the RANS HTML report, and a solver output log are present as possible later workflow references. They were inventoried only; job scripts were not run or deeply reviewed.
- Source review confirms gallery discovery is restricted to folders named exactly `3D` (case-insensitive) and containing PNG/JPEG/WebP images; normal `{Field}_{axis}-Section` handling is unchanged. No browser interaction check was performed for the new gallery.
- The interactive 3D toolbar now has signed-axis view presets (+/−X, +/−Y, +/−Z) plus isometric; the X/Y presets include roll so the Z axis stays vertical, consistent with the reference scene axis triads. Mouse rotation changes the preset label to **Custom**; reset returns to isometric.
- Added **Auto range** for the active field, using finite min/max cell values from the rendered surface types only. It is explicit so manually entered limits remain unchanged when switching fields, preserving like-for-like comparisons.
- Inspected static reference scene axis triads in `0830_mk3/3D/` to orient the presets. Source changes were reviewed and `git diff --check` passed; the gallery and new WebGL controls have not been exercised in a browser in this turn.
