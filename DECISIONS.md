# Decisions

Why HoMo CFD is built the way it is. Add a dated entry when a decision changes
how the app works or how contributors work; don't rewrite old entries — mark
them superseded instead. `SHARED_CONTEXT.md` holds the current spec.

## 2026-10-02 — Each person runs HoMo CFD offline on their own computer

HoMo CFD will be shared with teammates. Everyone runs it locally, without
internet, against their own results, which may live on any path. No hosted or
network-shared server: `serve.py` listens on 127.0.0.1 only.
**Why:** replaces CFD-Tool, which every team member ran on their own laptop.

## 2026-10-02 — Per-user working directory, like CFD-Tool

CFD-Tool stores one per-user working directory in
`%APPDATA%\CFD-Tool\resources\workingDir`, asks for it on first start, and
reads results from `<working dir>\finished`. HoMo CFD does the same with
`%APPDATA%\HoMo-CFD\settings.json`, falls back to CFD-Tool's saved setting,
and otherwise asks on first start (native folder dialog or pasted path).
**Why:** the user asked for CFD-Tool's behaviour; settings outside the app
folder survive updates and keep personal paths out of Git.
Supersedes the repo-local `homo-cfd.config.json` used earlier the same day.

## 2026-10-02 — serve.py indexes the results; the browser no longer needs a folder picker

`serve.py` serves the results folder read-only through `/api/tree`, `/api/list`
and `/api/file`; `web/server-fs.js` wraps them as File System Access-style
handles so the rest of the app is unchanged. The in-browser folder picker
remains only as a fallback when the page is opened without `serve.py`.
**Why:** agreed in the ChatGPT design conversation ("don't make me select the
folder every time"); works in any browser, including VS Code's Simple Browser.

## 2026-10-02 — Teammates install Python 3 for now

`Start HoMo CFD.bat` needs Python 3 (stdlib only). Bundling a portable Python
(unzip-and-run, like CFD-Tool's bundled Java) is a later improvement.
**Why:** the user chose to keep the current plan and do later improvements
after the main phases.

## 2026-10-02 — Sign-flipped −CzA and −CxA columns (removed the same day)

The team confirmed negative CzA is downforce and negative CxA is drag.
CzA and CxA are the downforce and drag **coefficients × reference area**, not
forces (correction from the user, same day; the columns were first labelled
`Downforce (−CzA)` / `Drag (−CxA)`). HoMo CFD shows `−CzA (downforce)` and
`−CxA (drag)` next to the exported monitors, which stay unchanged. `CzA Front (percentage)` is a fraction and is
displayed as exported.
**Why:** the user asked to keep the raw values and also show downforce and drag.
**Superseded:** once the force columns existed, the user asked to remove
`−CzA (downforce)` / `−CxA (drag)`. Downforce [N] and Drag [N] are now computed
directly from the CzA / CxA monitors and sit right after Iteration.

## 2026-10-02 — Downforce [N] and Drag [N] at a chosen speed

Requested by the user. `F = ½ · ρ · v² · (−CzA)` (and the same with CxA), with
one speed and density for all simulations, set in the table toolbar and kept
in the browser's local storage. Defaults: 60 km/h (CFD-Tool's preset speed)
and 1.18415 kg/m³ (STAR-CCM+'s default air density); the density must match
the reference density of the team's coefficient reports, which is stored in
the .sim file and not in the exported results.
**Why one speed:** comparing designs at the same speed is the common use, and
most result folders have no `Settings` file with the simulated speed
(`Vehicle State/Velocity`, km/h). Scaling with v² assumes CzA and CxA do not
change with speed; the hover note says so.
The force columns are computed when the table is drawn, not stored with the
cached CSV rows, so changing the speed or density only redraws the table.

## 2026-10-02 — Cluster code in `cluster.py`, WinSCP swappable for tests

WinSCP handling lives in `cluster.py` so `serve.py` stays about serving files
and settings. `Handler.winscp` is a `cluster.WinScp` object that the tests
replace with a fake, so no test reads the user's real sessions or contacts
Fritz. Scripts go through a temporary file (`/script=`) rather than
`/command` arguments, which avoids Windows command-line quoting problems.
**Why `/nointeractiveinput` and `option batch abort`:** WinSCP must never
wait for a password, passphrase or host-key prompt that nobody can see.

## 2026-10-02 — Stage 7: WinSCP, no remote delete, HoMo writes job scripts

User answers: WinSCP (as CFD-Tool), own Fritz account per user, never delete
on Fritz, HoMo CFD may generate the job scripts, download only after
post-processing. `launchV3.sh` could not be found, so HoMo CFD submits with
`sbatch mesh.sh`. The licence key location was unknown, so by default it is
kept per user in `%APPDATA%\HoMo-CFD\settings.json`, as CFD-Tool did.
**Why WinSCP saved sessions:** host, user and key stay inside WinSCP; HoMo
CFD stores only the session name. **Why `POST_DONE`:** `plots/DONE` is
written before post-processing, and WinSCP alone cannot ask SLURM cheaply,
so the generated `post.sh` writes its own marker. Details:
`docs/STAGE7_FRITZ.md` sections 4–5.

## 2026-10-02 — L/D column (aero balance column removed)

Requested by the user. `L/D` = CzA ÷ CxA (the same as Downforce ÷ Drag, so
it does not depend on the speed or density).
A `Balance [% front]` column (= CzA Front (percentage) × 100) was added the
same day and removed at the user's request; the exported `CzA Front` fraction
already shows the balance. The component monitors (FW, UT, RW, …) are per
part, not per axle, so a balance cannot be derived from them without moments.

## 2026-10-02 — Filenames are not parsed for navigation (except pressure linking)

Image sections are stepped by natural filename order, not by an mm position
parsed from the name. Pressure plots are the exception: the station in mm links
a pressure CSV to the matching section image and to other cases' stations,
and any mismatch is labelled.
**Why:** fields exist on different axes and counts (e.g. Lambda2 only on X),
so position-linking across fields was confusing (see `SHARED_CONTEXT.md`).

## 2026-10-02 — Tests use generated data

`tests/fixture.py` generates a small CFD-Tool-style working directory, so the
unit and browser tests run anywhere without the git-ignored real results.
