# Tests

Run both from the project folder before finishing a change. They need no real
CFD data: `fixture.py` generates a small CFD-Tool-style working directory
(two simulations with image sections, pressure CSVs, a coefficients history and
a tiny EnSight case) in a temporary folder. Real HoMo CFD / CFD-Tool settings
are never touched; both suites use a temporary `APPDATA`.

```text
py -m unittest discover -s tests -v     # serve.py and cluster.py: working directory, API, path safety, WinSCP (~20 s)
py tests/run_browser_tests.py           # whole app in headless Chrome or Edge (~2-4 min)
```

The browser suite needs Chrome or Edge installed (set `HOMO_TEST_BROWSER` to
the executable if it isn't found). It prints one PASS/FAIL line per check and
exits with code 0 when everything passes.

| File | What it covers |
| --- | --- |
| `test_serve.py` | working-directory precedence (command line, HoMo setting, CFD-Tool setting), `/api` listing and files, rejected paths and hosts, saving the working directory |
| `test_serve.py` → `BackgroundTests` | Window-less mode: idle stop rule (never while busy), `/api/alive` heartbeat, `/api/quit` refused during a download |
| `test_portable.py` | Portable build with a stand-in Python package (contents incl. `starccm/`, icon and shortcut script, no changelog, unpacked folder removed after zipping, CRLF start script, `._pth` patch, rebuild, rejected download) and the PowerShell dialog fallback (paths only in environment variables, cancel, failure) |
| `test_cluster.py` | WinSCP access with a fake WinSCP: input checks, login independent of the session's local folder, read-only test script, failure hints (passphrase first), running a script file (Windows), case states and stale detection, read-only status command, download script (exclusions, never deletes), download/move/cancel/failure, Settings parsing/validation, guarded case creation in one login (never uploads into an existing folder; missing template, refused login and interrupted upload messages), job and submit parsing, post-processing failure pattern and state; `test_serve.py` adds the `/api/cluster` calls including Pageant, case list with local state, downloads and their checks, job session test and jump-host warning, live jobs, template Settings, new case and Start rules |
| `browser/first-start.html` | no working directory yet: chooser (explains finished/inProgress, no CFD-Tool), wrong path rejected, results load |
| `browser/server-mode.html` | normal use with `serve.py`: results tree, Downforce/Drag [N] columns and deltas, sorting by a column header (both ways, Δ view, remembered, empty cells last, original order), comparison window (no hint line, 1–4 cases, minimum panel size, zoom keys), pressure plot, scene gallery, 3D viewer, Fritz cluster card, Simulations on Fritz list with a download, Start and New simulation (fake WinSCP) |
| `browser/picker-mode.html` | page opened without `serve.py` (mocked browser folder picker): single/multiple/nested simulations, unreadable CSV, hidden folders, frame stepping, background loading of whole sequences and kept frames, pressure off-station labels, gallery zoom, reconnect, 3D viewer range/NaN/field switching (the fixture has a car case with an empty part and a field name with a space, a `_flow` case with a Lambda2 part and a `_streamlines` case with two rows of four bar2 lines, values per point as STAR-CCM+ writes them (zero padding of varying length, space-padded records, a late piece), one line split at a shared point and one with a gap, one row running past the 1 m cut-off; a field file that leaves a part out; all three load as one model), Vortices checkbox, streamlines (lines, cut off 1 m behind the car, coloured by the field, view fitted to the surfaces, one checkbox for all rows; start grid by rows and columns, every Nth, height and width ranges, a piece after a gap stays with its line, remembered, All positions), streamline thickness (default, remembered, draws without errors), palettes (list, field and legend colours, remembered), toolbar on screen at 1000 px width, Save image draws at the asked size with a transparent background, surface flow (wall shear components hidden from the Field list, checkbox off at first, one line per cell along the surface with reversed flow pointing back), colour range per field and camera (never mirrored, front/top orientation, presets, turntable drag limits, pan, axes widget, arrow keys, Home, shading, zoom at the pointer) |

When you add a feature, add a check to the matching page (or a new page listed
in `run_browser_tests.py`) and extend `fixture.py` if it needs new data.
