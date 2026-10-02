# HoMo CFD handoff

HoMo CFD is a local-first web replacement for the legacy Java CFD-Tool. Treat `SHARED_CONTEXT.md` as the product and aero workflow spec and `STATUS.md` as the current implementation record. Read `AGENTS.md` and append every work task to `CHAT_HISTORY.md`.

## Current app

Run `py serve.py` from the project root and open http://127.0.0.1:5173 in Chrome or Edge. The main window browses results, summarizes final coefficient rows, and opens image-section comparisons. Folders named `3D` that contain images open a reference-scene gallery; use left/right arrow keys to step through the scenes. Pressure-distribution folders open aligned scatter plots with keyboard stepping. **Open 3D Cp viewer** opens a separate EnSight surface viewer.

## Current 3D sample and viewer

The workspace copy of `0830_mk3/3D-data/UPSI_CFD_BASE_0823.case` is a Frontwing-only EnSight surface case with five matching per-element fields: `CpX`, `CpZ`, `CpZCpX`, `PressureCoefficient`, and `TotalPressureCoefficient`. The viewer triangulates `tria3`, `quad4`, and `nsided` faces. **Auto range** uses the active rendered surface field's finite min/max; manual limits stay entered when fields change. Signed-axis (+/−X/Y/Z) and isometric view presets are available, with mouse rotation marked as Custom. The user visually confirmed that their selected full-car export renders in the browser and considers it sufficient; do not block on re-exporting that case. The workspace Frontwing field ranges are CpX −2.751…+2.343, CpZ −3.319…+2.135, CpZCpX −4.507…+2.957, and PressureCoefficient/TotalPressureCoefficient −3.720…+1.305. Adjust the interface range as needed; confirm field meanings and useful limits against STAR-CCM+ before engineering comparison.

The old 4.58 GB test2 export containing an `Air` volume part was superseded and is no longer the current input. Definitions of `CpX`, `CpZ`, and `CpZCpX` should still be confirmed against the STAR scene/reference. Browser validation using the actual Frontwing sample loaded 1,780,500 triangles and all five fields; CpZ Auto range matched −3.319 to +2.135. The native directory picker and static-scene gallery still need a user-browser check.

## Next step

The `0830_mk3/3D/` folder has 21 static reference scenes and is browsable from the results tree. Use the view presets to match the reference axis triads and **Auto range** to show the active field's complete surface range, then compare the static and interactive images. The pressure plot has been browser-checked against real FW/X data at 2420 mm (1,783 measurements). Current section sequences and final coefficient workflows also cover their sample folders.

Part-level show/hide controls, an orientation axis widget, and additional angled view presets are later improvements; the user considers the current full-car rendering and signed-axis presets sufficient for now. The user confirmed the side-view orientation fix works.

## Remaining work

1. Check the static 3D gallery and native directory picker in the user's browser.
2. Validate Stage 5 coefficient monitor names, signs, and units against CFD-Tool/STAR-CCM+ before interpreting raw monitor differences as downforce, drag, or front balance.
3. Keep volume cuts, broader EnSight/STAR-CCM+ compatibility, part-level visibility, an orientation widget, and extra angled presets in the later-improvements list. The user confirmed the full-car surface display is enough for now.
