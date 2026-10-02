# HoMo CFD

Web viewer for Formula Student STAR-CCM+ postprocessing results. This is a modern replacement for the existing CFD-Tool (PNG sections + later CSV plots and four-case compare).

## Run

This machine does not need Node. Python 3 is enough.

```bash
py serve.py
```

Open http://127.0.0.1:5173 in Chrome or Edge. Choose the results root once with **Open folder**; HoMo CFD remembers it when browser permissions allow. The workspace shows one collective table with each simulation's final coefficients iteration; coefficient values use three decimal places. Use **Customize columns** to rename, hide, or reorder columns. **Δ vs reference** compares exported monitor values to a selected simulation; the collapsible monitor chart visualizes one raw monitor at a time. Differences are current minus reference, with no sign or unit conversion. Click an image section to open a new comparison window seeded with that simulation. Use **Add case** inside the window to bring in more simulations; each panel has independent field and axis controls. Zoom and pan are synchronized automatically; **Sync images** synchronizes frame stepping. The Pressure plots view overlays populated FW/UT/RW X/Y stations. Allow pop-ups for the local app.

The main window also has **Open 3D Cp viewer** for a separate experimental EnSight Gold surface view. The current `0830_mk3/3D-data` sample is the Frontwing surface with per-element `CpX`, `CpZ`, `CpZCpX`, `PressureCoefficient`, and `TotalPressureCoefficient` fields. The viewer supports `tria3`, `quad4`, and `nsided` faces, field and color-range selection, an **Auto range** action based on the selected surface field, and isometric plus signed-axis view presets. Folders named `3D` that contain static images appear in the results tree as a scene gallery; open one and use the left/right arrow keys to browse its reference scenes. An earlier 4.58 GB volume export is not suitable for the current interactive viewer.

## Project history

All contributors must read `AGENTS.md` and append their work conversations to `CHAT_HISTORY.md` before completing a task. Record visible requests and responses verbatim, along with changed files and verification. Do not rewrite older entries.

## Keep ChatGPT in sync

1. Paste `HANDOFF_FOR_CHATGPT.md` into ChatGPT once.
2. After Cursor changes something, paste `STATUS.md`.
3. Spec lives in `SHARED_CONTEXT.md` — correct that file if the aero workflow is wrong.
