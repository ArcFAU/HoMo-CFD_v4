# Stage 7 — Fritz cluster integration (design draft)

Status: **draft for review, nothing implemented.** Written 2026-10-02 from a
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

## 4. Answers so far (user, 2026-10-02)

- **Accounts (Q1, part):** usually everyone uses their **own Fritz account**.
  So connection settings are per user and per PC (host alias / user name in
  `%APPDATA%\HoMo-CFD\settings.json`, keys in the user's own SSH/PuTTY
  setup). The OpenSSH (B) vs WinSCP/PuTTY (A) choice is still open.
- **Download timing (Q3):** download **after post-processing** has finished
  (images ready), not at `plots/DONE`.
  - Finding: `rans.sh` writes `plots/DONE` right after the solver, *before*
    `post.sh` runs, and `post.sh` writes no completion marker. So `plots/DONE`
    alone cannot be the trigger.
  - Options: (a) ask SLURM whether the case's `post` job has finished
    (`squeue` / `sacct` over SSH; needs option B or PuTTY's `plink`);
    (b) have `post.sh` write a marker such as `plots/POST_DONE` as its last
    step (needs the job scripts to change, see Q5); (c) look for post-processing
    output (section folders, `RANS.html`) — fragile, as a run can stop half-way.
  - Proposal: (a) as the main signal, plus (b) once HoMo CFD writes the job
    scripts.
- **`launchV3.sh` (Q2):** the user did not know this script. Where it comes
  from: CFD-Tool's `InProgress` class (in `CFD-Tool.jar`) builds `upload.bat`
  with `set LAUNCH_SCRIPT=/home/…/Pipeline/launchV3.sh` and
  `call %LAUNCH_SCRIPT%`, so CFD-Tool runs it on Fritz after every upload. It
  is a cluster-side file, probably set up by whoever wrote CFD-Tool; it is
  not in the project or the result folders. Next step: look for
  `Pipeline/launchV3.sh` in the team's Fritz folder or ask CFD-Tool's author.
  If it cannot be found, HoMo CFD can start the chain itself with
  `sbatch mesh.sh` in the uploaded case folder.

Still open: Q1 connection method, Q2 (what `launchV3.sh` does, if it
exists), Q4 remote clean-up, Q5 job-script generation, Q6 licence key.
