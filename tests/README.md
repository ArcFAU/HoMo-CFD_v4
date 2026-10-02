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
| `test_cluster.py` | WinSCP access with a fake WinSCP: input checks, read-only test script, failure hints (passphrase first), running a script file (Windows); `test_serve.py` adds the `/api/cluster` calls including Pageant |
| `browser/first-start.html` | no working directory yet: chooser, wrong path rejected, results load |
| `browser/server-mode.html` | normal use with `serve.py`: results tree, Downforce/Drag [N] columns and deltas, comparison window (1–4 cases, minimum panel size, zoom keys), pressure plot, scene gallery, 3D viewer, Fritz cluster card (fake WinSCP) |
| `browser/picker-mode.html` | page opened without `serve.py` (mocked browser folder picker): single/multiple/nested simulations, unreadable CSV, hidden folders, frame stepping and memory, pressure off-station labels, gallery zoom, reconnect, 3D viewer range/NaN/field switching |

When you add a feature, add a check to the matching page (or a new page listed
in `run_browser_tests.py`) and extend `fixture.py` if it needs new data.
