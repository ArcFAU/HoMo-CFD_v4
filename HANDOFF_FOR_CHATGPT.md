# HoMo CFD handoff

HoMo CFD is a local, offline web replacement for the team's Java CFD-Tool. `SHARED_CONTEXT.md` is the product and aero-workflow spec, `STATUS.md` the implementation record, `DECISIONS.md` the reasons behind major choices, `TASK.md` the current task, and `CHANGELOG.md` the user-visible history. Contributors read `AGENTS.md` and append every task to `CHAT_HISTORY.md`.

## How it runs (state 2026-10-02)

- Each person runs HoMo CFD on their own computer, offline, against their own results. Double-click `Start HoMo CFD.bat` (needs Python 3; a bundled Python is a later improvement). The app opens at http://127.0.0.1:5173 in any browser.
- Like CFD-Tool, a per-user **working directory** is chosen once (Browse… or pasted path) and saved in `%APPDATA%\HoMo-CFD\settings.json`; CFD-Tool's saved working directory is reused automatically. Results come from `<working dir>\finished`.
- `serve.py` indexes the results folder and serves it read-only (127.0.0.1 only). Without `serve.py`, Chrome/Edge can still pick a folder in the browser.

## What works

- Results tree with search; one collective coefficient table (final iteration per simulation) with **Downforce [N]**, **Drag [N]** and **L/D** computed columns (forces at a speed and air density set in the toolbar), Values / Δ-vs-reference modes, customizable columns and a monitor bar chart. CzA/CxA are the downforce/drag coefficients × reference area (not forces); negative CzA = downforce, negative CxA = drag; CzA Front is a fraction.
- Comparison windows for image sections: up to four cases, each with its own field/axis/frame; synchronized zoom and pan; keys ←/→ (frames), T/V/P/L (field), X/Y/Z (axis), + / − / 0 (zoom). With 3–4 cases panels keep a readable size and the window scrolls.
- Pressure distributions (FW/UT/RW × x/y): up to four cases overlaid, stations stepped with ←/→, optional linked scene images; a case or image from a different station is labelled.
- 3D: static scene galleries from `3D` folders; an interactive EnSight Gold surface viewer (tria3/quad4/nsided, per-element fields, auto range, axis presets) opened from `3D-data` tree entries. The user's full-car export renders.
- Tests: `py -m unittest discover -s tests` (15) and `py tests/run_browser_tests.py` (67 headless checks) on generated data.

## Next

1. Stage 7 (Fritz cluster: submit, monitor, download, delete) — design first, see `TASK.md`; needs the team's choice of authentication before any implementation. Decided: WinSCP saved sessions, own Fritz account per user, submit with `sbatch mesh.sh`, HoMo writes job scripts (`post.sh` writes `plots/POST_DONE`), download after post-processing, never delete on Fritz; see `docs/STAGE7_FRITZ.md` section 5.
2. The user will add more result folders; check loading speed with 100+ simulations.
3. Later improvements (after the main phases): bundled Python, 3D orientation widget, angled presets, part show/hide.
