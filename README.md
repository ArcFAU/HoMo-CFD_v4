# HoMo CFD

Web viewer for Formula Student STAR-CCM+ postprocessing results. This is a modern replacement for the existing CFD-Tool (PNG sections + later CSV plots and four-case compare).

## Run (each person on their own computer, offline)

You need **Python 3** (free from python.org; tick "Add python.exe to PATH" when installing). Nothing else: no internet, no Node, no installation step for HoMo CFD itself.

1. Copy the HoMo CFD folder anywhere on your computer.
2. Double-click **`Start HoMo CFD.bat`**. A small window opens (keep it open while you work; close it to stop HoMo CFD) and the app opens in your browser at http://127.0.0.1:5173.
3. First start only: choose your **working directory**, the same folder CFD-Tool uses (the one with `finished`, `inProgress`, `archive` inside). Click **Browse…** or paste the path. HoMo CFD lists the simulations in its `finished` folder. A folder without `finished` is used as the results folder itself (one simulation, a folder of simulations, or a deeper tree all work).

Like CFD-Tool, the choice is saved per user, outside the app folder (`%APPDATA%\HoMo-CFD\settings.json`), so everyone can keep results on a different path and updating the app keeps the setting. If you already use CFD-Tool, HoMo CFD picks up CFD-Tool's working directory automatically and skips step 3. Change it any time with **Working directory** in the sidebar. Reload the page to rescan after new results arrive.

From a terminal: `py serve.py --open` does the same as the batch file; `py serve.py --working-dir "D:\CFD_tool"` uses another folder for one run. If the page is opened without `serve.py`, Chrome or Edge can still pick a folder with **Open folder**.

**Fritz cluster** (sidebar, optional): HoMo CFD talks to Fritz through **WinSCP**, like CFD-Tool. Create a WinSCP *saved session* for your own Fritz account (host, user name, key) and log in with WinSCP once to accept the host key. If your key has a passphrase, click **Unlock key with Pageant** first (Pageant asks for the passphrase in its own window; HoMo CFD never sees it, and you unlock it again after restarting Windows). Then choose that session and your remote folder in **Fritz cluster** and click **Test connection**. HoMo CFD only remembers the session's name and the folder; your login stays in WinSCP. Below that, **Simulations on Fritz** lists the cases in your remote folder with their state (read from their job files) and downloads finished ones into your working directory (`inProgress` while downloading, then `finished`). `.sim` files are skipped unless you tick the box. HoMo CFD never changes or deletes anything on Fritz. Preparing and submitting new cases come next.

The workspace shows one collective table with each simulation's final coefficients iteration; coefficient values use three decimal places. Use **Customize columns** to rename, hide, or reorder columns. **Δ vs reference** compares exported monitor values to a selected simulation; the collapsible monitor chart visualizes one raw monitor at a time. Differences are current minus reference, with no sign or unit conversion. Click an image section to open a new comparison window seeded with that simulation. Use **Add case** inside the window to bring in more simulations; each panel has independent field and axis controls. Zoom and pan are synchronized automatically; **Sync images** synchronizes frame stepping. The Pressure plots view overlays populated FW/UT/RW X/Y stations. Allow pop-ups for the local app.

The main window also has **Open 3D Cp viewer** for a separate experimental EnSight Gold surface view; `3D-data` folders that contain a `.case` file also appear in the results tree as **3D-data · 3D viewer** and open it directly. The current `0830_mk3/3D-data` sample is the Frontwing surface with per-element `CpX`, `CpZ`, `CpZCpX`, `PressureCoefficient`, and `TotalPressureCoefficient` fields. The viewer supports `tria3`, `quad4`, and `nsided` faces, field and color-range selection, an **Auto range** action based on the selected surface field, and isometric plus signed-axis view presets. Folders named `3D` that contain static images appear in the results tree as a scene gallery; open one and use the left/right arrow keys to browse its reference scenes. An earlier 4.58 GB volume export is not suitable for the current interactive viewer.

## Project history

All contributors must read `AGENTS.md` and append their work conversations to `CHAT_HISTORY.md` before completing a task. Record visible requests and responses verbatim, along with changed files and verification. Do not rewrite older entries.

## Keep ChatGPT in sync

1. Paste `HANDOFF_FOR_CHATGPT.md` into ChatGPT once.
2. After Cursor changes something, paste `STATUS.md`.
3. Spec lives in `SHARED_CONTEXT.md` — correct that file if the aero workflow is wrong.
