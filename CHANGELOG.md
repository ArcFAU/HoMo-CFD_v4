# Changelog

User-visible changes, newest first. Detailed reasoning lives in
`CHAT_HISTORY.md`; decisions in `DECISIONS.md`.

## 2026-10-02

### Added
- **Downforce (−CzA)** and **Drag (−CxA)** columns next to the exported monitors, in values and Δ-vs-reference views; the monitor chart starts on Downforce.
- **Working directory** like CFD-Tool: chosen once per user (Browse… or paste a path), saved in `%APPDATA%\HoMo-CFD\settings.json`; CFD-Tool's saved working directory is reused automatically; results come from its `finished` folder.
- `serve.py` indexes the results folder: no browser folder picker or permission prompts, works offline in any browser.
- `Start HoMo CFD.bat` double-click launcher.
- `3D-data` folders open the 3D viewer straight from the results tree.
- Comparison window: X/Y/Z axis keys; `+` / `-` / `0` zoom keys (also in the scene gallery); with 3–4 cases each panel keeps at least 420 px height and the window scrolls instead of shrinking images.
- One-click **Reconnect** when a browser-picked folder needs permission again.
- Tests: `tests/test_serve.py` and the headless browser suite `tests/run_browser_tests.py` on generated data.

### Changed
- Faster start-up with many simulations: 120 simulations load in about 4 s (was 5.7 s).

### Fixed
- Choosing a single simulation folder as the results root broke image sections and named the simulation "plots".
- Simulations nested below the results root were missing from Add case and pressure overlays.
- Pressure overlays silently mixed stations; off-station cases and scene images are now labelled. Missing x-axis label and "undefined" chart title.
- Unreadable coefficient files disappeared silently; they are now listed.
- Comparison window memory grew with every visited frame; held arrow keys could skip or step backwards; errors were only in the console.
- Scene gallery zoom could not reach the image edges.
- 3D viewer: NaN cell values, reversed colour range, legend rounding, fast field switching; the triangle count showed three times the real number.
- Server refused some requests during bursts (pressure stations) on Windows.
- `.git` and other hidden folders were indexed.

### Removed
- About 700 lines of unused legacy slot-UI code.
