Last updated: 2026-09-28

## Done

- The landing view is a searchable filesystem tree. The chosen results-root handle is stored in IndexedDB and restored when browser permission remains granted.
- The workspace displays only one collective table: the final data row from each `Coefficients*.csv`, one row per simulation. Coefficient values display to three decimal places and the iteration number as an integer. No other CSV tables or full coefficient histories are rendered.
- **Customize columns** allows renaming, hiding, and reordering coefficient columns. Preferences persist in browser local storage; values remain bound to original CSV headers.
- CSV discovery covers section-like folders even when they also contain images. Actual image files are not read during root indexing.
- Clicking an image section opens a comparison window seeded with that simulation and selected field/axis; **Add case** inside the window adds more simulations. The main window has no comparison case slots.
- Each panel has independent field, axis, and frame controls; zoom and normalized pan are always synchronized without UI toggles. Left/right keys step the focused panel unless optional **Sync images** is enabled.
- Zoom uses explicit fit-relative dimensions inside scrollable image stages rather than CSS transforms, so enlarged images remain fully reachable. Zoom changes preserve the viewport center; reset returns all panels to fit.
- Image sequences are indexed without eagerly reading every file; the current and adjacent frames are decoded ahead and retained for smooth stepping. A real Cp/X sequence opened with its first image ready in about 0.8 seconds; the next-frame step measured about 11 ms.
- Browser-checked against the remembered `finished` folder: the table contains seven simulation rows and only one rendered table; the first simulation's final iteration is `1000.0`. Opening a real image seeded a one-case comparison; adding a second simulation allowed independent Cp/Y and Velocity/X panels at full resolution.

## Open items

- The temporary logo was removed. The original HV Motorsports logo file is not present in the workspace or Downloads and needs to be supplied before it can be added.
- The browser File System Access API and pop-ups require a Chromium browser (Chrome or Edge) and local-app permissions.
- CSV pressure-distribution plotting remains blocked on a populated sample; those CSV tables are intentionally not displayed in this view.

## How to run

```text
cd C:\Users\Archit\Downloads\HoMo-CFD
py serve.py
```

Open http://127.0.0.1:5173
