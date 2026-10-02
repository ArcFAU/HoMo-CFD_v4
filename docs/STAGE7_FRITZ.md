# Stage 7 — Fritz cluster integration (design draft)

Status: **design decided 2026-10-02 (sections 4–5); step 1 (connection settings + Test connection) built, see `cluster.py`.** Written 2026-10-02 from a
read-only study of CFD-Tool (class constants and `javap` disassembly; the
`p.ppk` key was never opened) and the `mesh.sh` / `rans.sh` / `post.sh` job
scripts in a downloaded result folder (licence key masked, not copied).

Goal: from HoMo CFD, **submit** a prepared simulation to NHR FAU Fritz,
**monitor** it, **download** the results into the working directory, and
**clean up** on the cluster — replacing CFD-Tool's buttons plus manual
WinSCP/PuTTY work. The viewer must keep working fully offline without any of it.

## 1. How CFD-Tool does it today

CFD-Tool's working directory has one folder per stage of a simulation's life:

```text
unsimulated/  →  inProgress/  →  finished/  →  archive/
 (prepared)       (on Fritz)     (results)     (kept)
```

| Step | What CFD-Tool does |
| --- | --- |
| Prepare (`Unsimulated`) | Writes `mesh.sh`, `rans.sh`, `post.sh` SLURM scripts from the case `Settings` (job name, nodes, time, partition; STAR-CCM+ licence key inserted from its config). |
| Submit (`InProgress.createUploadBatch`) | Generates `upload.bat` that runs **WinSCP** (`WinSCP.com /command`): `open sftp://…` with the user's PuTTY key → `put` the case folder into the team's `Pipeline` folder on Fritz (`/home/vault/<group>/<user>/Pipeline/`) → `call …/Pipeline/launchV3.sh` (a cluster-side script, not in our files). |
| Run (on Fritz) | `mesh.sh` → `sbatch rans.sh` → `sbatch post.sh`: each job submits the next. `rans.sh` writes `plots/DONE` right after the solver, **before** post-processing has run. |
| Monitor (`downloadPlots.bat`) | For every case in `inProgress`, WinSCP `get`s the remote `plots` folder (residuals, `Coefficients*.csv`). |
| Finish (`isDone` → `moveToFinished`) | When `plots/DONE` exists locally, the case moves from `inProgress` to `finished`. |
| Archive / delete (`DeletionConfirmationFrame`) | Copies a finished case to `archive` and deletes it from `finished`, with a confirmation dialog. |

Settings kept by CFD-Tool per user: the WinSCP "open" line (host, user, key
options) and the PuTTY key file, chosen in its config window.

## 2. Proposed HoMo CFD design

### Principles
- **Optional and local.** Cluster features appear only after the user sets up
  a connection; the viewer never depends on them. `serve.py` runs the transfers
  on the user's own computer (still 127.0.0.1 only).
- **No secrets in HoMo CFD.** No passwords, private keys or licence keys in the
  repo or in `%APPDATA%\HoMo-CFD\settings.json`. HoMo CFD only stores the host
  alias / user name and the remote `Pipeline` path; keys stay where the user
  already keeps them (PuTTY/Pageant or `~/.ssh`).
- **Same folders as CFD-Tool,** so both tools can be used side by side during
  the switch.
- **Every destructive step asks first** (cancel job, delete remote folder,
  archive/delete local results) and is logged.

### Connection: two options (decision needed)
| | A. WinSCP + PuTTY key (as CFD-Tool) | B. Windows built-in OpenSSH |
| --- | --- | --- |
| Install | WinSCP + PuTTY (team already has them) | nothing (built into Windows 10/11) |
| Key | existing `.ppk` | convert once with PuTTYgen to an OpenSSH key, or load it into Pageant |
| Transfers | WinSCP scripts (`put` / `get` / `synchronize`) | `scp` / `sftp` |
| Monitoring | only by downloading `plots` | also `squeue` / `sacct` over `ssh` → real job state, queue position, run time |
| Cancel a job | not possible | `scancel` |

Recommendation: **B (OpenSSH) as the main path**, because it allows live job
status and cancelling without extra software; **A as a fallback** for teammates
who only want to keep their current CFD-Tool setup. Both are stdlib-only on the
HoMo side (Python starts `ssh.exe` / `WinSCP.com`; no Paramiko).

### Licence key
Today the STAR-CCM+ `-podkey` value is written into every job script on the
laptop. Proposal: keep the key **only on Fritz** (e.g. a file in the user's
cluster home readable only by them) and have the generated scripts read it
there. Then it never sits in result folders that get copied or shared.

### Features, in build order
1. **Connection setup and test** — host, user, `Pipeline` path; a "Test
   connection" button that runs a harmless `ssh <host> echo ok`.
2. **Monitor (read-only)** — an *In progress* section in the results tree:
   SLURM state per case (pending / running / finished / failed, elapsed time)
   and a residual/coefficient preview from the downloaded `plots` folder,
   refreshed on demand or every few minutes.
3. **Download** — fetch a finished case into `finished/` (skip files already
   present; resume after interruptions); show progress.
4. **Submit** — upload a prepared case from `unsimulated/` to `Pipeline/` and
   start it (either `launchV3.sh`, as CFD-Tool does, or `sbatch mesh.sh`).
   Generating `mesh/rans/post.sh` from `Settings` (CFD-Tool's `Unsimulated`
   step) is a separate, larger item: it needs a Settings editor.
5. **Clean up** — cancel a job, delete the remote case folder after a verified
   download, archive local cases. All with confirmation.

Steps 1–3 are read-only for the cluster except downloads; steps 4–5 change
things on Fritz and come last.

## 3. Questions for the team (needed before building)

1. Connection: OpenSSH (B) or keep WinSCP + PuTTY (A)? Does everyone use their
   own Fritz account, or one shared team account?
2. What does `Pipeline/launchV3.sh` do on Fritz (copy of the cluster file, or a
   short description)? Should HoMo CFD call it like CFD-Tool, or submit
   `mesh.sh` directly?
3. Is `plots/DONE` (solver finished) the right moment to download, or should
   HoMo CFD wait for post-processing to finish (images ready)?
4. After a successful download, should the remote case folder be deleted
   automatically, kept, or deleted on request only?
5. Should HoMo CFD also generate the job scripts from `Settings` (replacing
   CFD-Tool's preparation step), or keep using CFD-Tool / existing scripts for
   that for now?
6. OK to move the licence key out of the job scripts into a file on Fritz?

## 4. Answers (user, 2026-10-02)

| # | Question | Answer |
| --- | --- | --- |
| 1 | Connection, accounts | **WinSCP** (option A). Usually everyone uses their **own Fritz account**. |
| 2 | `launchV3.sh` | Not found anywhere by the user → HoMo CFD starts the chain itself with `sbatch mesh.sh`. |
| 3 | When to download | **After post-processing** has finished (images ready). |
| 4 | Remote clean-up | **No delete.** HoMo CFD never deletes anything on Fritz. |
| 5 | Generate job scripts | **Yes**, HoMo CFD can write `mesh.sh` / `rans.sh` / `post.sh` from `Settings`. |
| 6 | Licence key | Unknown → see "Licence key" below. |

Findings behind these answers (read-only checks on this PC):

- **`launchV3.sh`:** CFD-Tool's `InProgress` class (in `CFD-Tool.jar`) builds
  `upload.bat` with `set LAUNCH_SCRIPT=/home/…/Pipeline/launchV3.sh` and
  `call %LAUNCH_SCRIPT%`. The script is cluster-side and probably belonged to
  CFD-Tool's author; it is not in the project or the result folders.
- **Post-processing signal:** `rans.sh` writes `plots/DONE` right after the
  solver, *before* `post.sh` runs, and `post.sh` writes no completion marker.
  So `plots/DONE` cannot be the download trigger.
- **WinSCP:** `WinSCP.com` is installed in `C:\Program Files (x86)\WinSCP`, and
  there are saved WinSCP sessions on this PC. CFD-Tool's batch templates
  support both `open sftp://…` and `open <saved session name>`. CFD-Tool's own
  WinSCP line and key file on this PC are empty, so it was not used for the
  cluster here.
- **Licence key:** not stored in CFD-Tool (jar or config) or in any `Settings`
  file; it appears only in already generated job scripts and in the job log
  (`resTAURANtS.o…`). It came from the CFD-Tool setup of whoever prepared those
  cases.
- **Run settings** in `Settings` (`Run Settings/…`): mesh/RANS nodes and hours,
  post hours, accelerated post-processing, download options (`Download
  Folders`, `Download Sim`) and CFD-Tool's delete options (`Delete Remote Sim`,
  `Remote Delete Time`, `Local Delete Time`). HoMo CFD ignores the delete
  options (answer 4).

## 5. Final design (to build)

**Connection.** Per user and per PC, stored in `%APPDATA%\HoMo-CFD\settings.json`:
the WinSCP saved-session name (HoMo CFD lists the names; the session holds
host, user and key inside WinSCP, so HoMo CFD stores no secrets) and the remote
`Pipeline` folder. `serve.py` runs `WinSCP.com /command …` with a generated
script; only when the user clicks a button.

**Licence key.** Default: entered once per user and kept only in
`%APPDATA%\HoMo-CFD\settings.json` (never in the repo), then written into the
generated job scripts — the same as CFD-Tool does today. Later option: a file
on Fritz that the job scripts read, so the key stops appearing in result
folders and job logs.

**Lifecycle** (same folders as CFD-Tool):

1. **Prepare** (`unsimulated/<case>`): HoMo CFD writes `mesh.sh`, `rans.sh`,
   `post.sh` from the case `Settings` (CFD-Tool's templates). `post.sh` ends
   with `> plots/POST_DONE` after STAR-CCM+ exits.
2. **Submit:** `put` the case folder to `<Pipeline>/<case>`, then
   `call cd <Pipeline>/<case> && sbatch mesh.sh`; move the local folder to
   `inProgress/`.
3. **Monitor** (on demand, or every few minutes while HoMo CFD is open): `get`
   each in-progress case's `plots` folder (residuals, `Coefficients*.csv`) and
   show progress: meshing / solving / post-processing / done.
4. **Download:** when `plots/POST_DONE` exists, `get` the case into
   `finished/<case>` (respecting `Download Folders` / `Download Sim`), verify
   it, then remove the local `inProgress/<case>` copy. Older cases without the
   marker: offer a manual "Download now".
5. **No remote delete**, ever.

**Build order:** (1) connection settings + **Test connection** (WinSCP `open` +
`pwd` + `exit`); (2) monitor + download for cases already in `inProgress`;
(3) job-script generation; (4) submit. Steps 1–2 only read from Fritz.
