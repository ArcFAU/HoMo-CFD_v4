# Status

Last updated: 2026-09-26 (Claude, round 3 — architecture pivot from real screenshots + a real Coefficients CSV)

## Done

- Repo at `C:\Users\Archit\HoMo-CFD`. `SHARED_CONTEXT.md` is the spec — read it first.
- Filename → mm-position parsing **removed entirely** (see `SHARED_CONTEXT.md`). Root cause of the "different kind of section does not change with others" report: `Lambda2` is only computed on the X axis for these cases, so linking it to a Y target was correctly reporting "unavailable" — not a bug, just a confusing message for a real mismatch. Sections are now stepped by plain filename order (index), not physical position.
- **Navigation**: dropdown and slider for position removed (the slider's `render()`-on-every-`input` tick was fighting the drag, per your screenshot). Now just ◀ ▶ buttons + "Frame N / M", and left/right arrow keys step whichever panel was last clicked (highlighted with an accent border). Arrow keys are ignored while a dropdown/input has focus.
- **Case loading**: "Open results folder" scans a parent folder (e.g. `finished`) for every subfolder that looks like a case, without reading any images yet; case slots A–D become dropdowns into that list (plus "Browse…" for a one-off folder). Opening the results root now auto-loads only the **first** case (single-case-first), not all 4 — matches "I usually open one case to look through."
- **Panel layout is now 1:1 with loaded cases**, not a fixed 4-grid: 1 case = 1 full-size panel, 2 = side-by-side, up to 4 = 2×2. No case-picker dropdown inside each panel anymore (a panel *is* a case slot now). Images use `object-fit: contain` so they shrink to fit but are never cropped, per your last message.
- Field selector is a dropdown (was a chip wall eating the panel's height — main cause of the squeezed/unreadable image in your first screenshot). Axis stays as chips (only ever X/Y/Z).
- **Coefficients summary table**, built against your real `Coefficients_49.csv`: each case's `plots/Coefficients*.csv` is a per-iteration convergence log; the app takes the **last row** as that case's converged values and shows a table above the panels — one row per loaded case, columns matching CFD-Tool's home screen (`CzA Front(%)`, `CzA`, `CzA FW`, `CzA UT`, `CzA RW`, `CzA MO`, `CzA Rem`, `CxA`, `CxA FW`, `CxA UT`, `CxA RW`, `CxA Mono`, `CxA Rem`).
- Tested this round differently from rounds 1–2: built a mock File System Access API in Node (`/mnt/user-data/uploads` equivalents aren't on this machine, but the *logic* is testable) and ran `scanCaseFolder` against your actual `Coefficients_49.csv` plus synthetic section folders — confirmed frame ordering, `axesForField` correctly reporting `Lambda2` as X-only, coefficient values matching the CSV's last row, and the link/step/broadcast logic (including the "linked but axis unavailable" case) end to end. Still not run in an actual browser against your full real folder tree by me.

## Open items

- Assumes exactly one `Coefficients*.csv` per `plots/` folder. If a case's `plots/` ever has more than one (e.g. per-config variants), the app currently just takes whichever the folder listing yields first — flag if that happens.
- CSV pressure-distribution plotting (Stage 4) — still blocked on one populated `PressureDistributions` CSV.
- No persistence — reopening the browser loses all loaded cases (File System Access API handles aren't saved).

## Next (do not skip)

1. Run `py serve.py`, open the real results folder, confirm: single case loads by default, arrow keys/buttons step frames, the summary table's numbers match CFD-Tool's home screen for a case you know, and loading a 2nd/3rd/4th case grows the panel grid without cropping images.
2. Get one populated pressure-distribution CSV to unblock Stage 4.

## How to run

```text
cd C:\Users\Archit\HoMo-CFD
py serve.py
```

Open http://127.0.0.1:5173
