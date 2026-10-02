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

## 2026-10-02 — Image viewer: speed over memory

The user prefers speed and reliability to a small memory footprint. Image
sequences are therefore loaded completely in the background (nearest frames
first, 6 in parallel) and kept for as long as the case is open, including the
sections it showed before. The earlier limit of ±2 decoded frames is gone. A
case's compressed files are small (about 0.3 MB per section image); decoded
bitmaps are managed by the browser.

## 2026-10-02 — 3D viewer: a colour range per field

Fields now differ by orders of magnitude (Cp around −5…1, skin friction around
0.01, velocity tens of m/s), so one shared range no longer works. Each field
keeps the range the user set (or Auto range) in the browser, which still gives
like-for-like comparisons between cases; untouched fields start at −5…1 (Cp
fields) or at their own 1st–99th percentile. Flow parts from the export
(vortex iso-surface, bad cells) get checkboxes instead of general part
show/hide, which the user did not need.

## 2026-10-02 — 3D data exported by a separate macro the post-processing plays

The 3D viewer needs EnSight surface data for every case, so STAR-CCM+ should
export it during post-processing on Fritz. The export lives in its own file,
`export3D.java`, which `postprocessing.java` plays through `StarScript` inside
a catch-all: a compile or runtime error in the export can never break the
images and plots, and cases without the file skip it. Only wall boundaries
of the car are exported (no volume, values per cell), matching what the
viewer reads and keeping a full car around 100 MB.

## 2026-10-02 — Portable build with Python's embeddable package

Teammates should unzip and run, like CFD-Tool with its bundled Java. Python's
official Windows embeddable package (about 13 MB) is enough because HoMo CFD
uses only the standard library; it lacks tkinter, so the Browse… dialogs fall
back to the Windows dialogs through PowerShell. The package is downloaded by
`tools/make_portable.py` (pinned version and SHA-256), not committed to git;
the zip is built and shared by whoever distributes HoMo CFD.

## 2026-10-02 — 3D viewer: turntable camera in STAR-CCM+ coordinates

Free yaw/pitch/roll rotation made the car tumble and the image was mirrored.
A turntable (turn around +Z, tilt up to ±90°) keeps the car upright, which is
how vehicles are usually inspected. Views are named after the car (nose at
+X, +Y = left, +Z up, as in the team's STAR-CCM+ scenes) and keep the axis in
the label. Part show/hide was not needed.

## 2026-10-02 — New simulations copy the team template; jobs start via a login-node session

The team prepares cases on Fritz by copying `SCRIPT_FABSI`, so HoMo CFD does
the same instead of generating scripts: CFD-Tool's generator is outdated and
the team's scripts (which already contain the licence key) stay untouched, as
the user chose. HoMo CFD only writes Settings (edited in a form) and uploads
the base `.sim`. Creation uses only WinSCP's own commands in one login
(update the same day): `call` needs a second login, which the csnhr jump host
sometimes refuses, and does not stop on errors. The template's small files
are fetched to a temporary local folder, then `mkdir <case>` is the guard (a
failing WinSCP command stops the script, so nothing is uploaded into an
existing folder), then the files, Settings and `.sim` are uploaded. Jobs start with
`sbatch mesh.sh` through a second WinSCP session to a Fritz login node (the
jump host has no SLURM), after a confirmation, only for cases that have not
started. The licence key no longer needs a place in HoMo CFD.

## 2026-10-02 — Step 2 reads state from files; downloads via inProgress

The WinSCP session reaches csnhr, a jump host without SLURM, so HoMo CFD
cannot ask the queue. Instead one read-only shell loop (WinSCP `call`)
reports each case's marker files and logs. "Ready to download" = the newest
`post.o*` log contains "Job finished at" (or `plots/POST_DONE`). A run that
dies leaves no marker, so unfinished cases without a log update for 12 h are
shown as "probably stopped" and can still be downloaded on request.
Downloads use `synchronize local` (only writes locally, resumes, never
deletes remotely) into `inProgress\<case>` and move to `finished\<case>` when
complete, like CFD-Tool. Skipped: `*.sim~`, `*.sh`, `*.java` (the job scripts
contain the licence key), `ABORT*`; `*.sim` (10–20 GB) only when ticked.
**Why POST for the status check:** it starts WinSCP; a GET could be triggered
by any web page (e.g. an image tag) on this computer.

## 2026-10-02 — Passphrase-protected keys go through Pageant

The user's Fritz key has a passphrase. HoMo CFD does not ask for it or pass
it to WinSCP (that would put a secret in HoMo CFD's requests and temporary
script files). Instead **Unlock key with Pageant** starts PuTTY's Pageant with
the key file set in the WinSCP session; Pageant asks for the passphrase in its
own window and WinSCP uses Pageant automatically. This also suits step 2,
where HoMo CFD checks running cases repeatedly. Pageant forgets the key when
it is closed or Windows restarts, so it is unlocked once per session.

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
