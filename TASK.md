# Current task

One task at a time (see the pipeline in `SHARED_CONTEXT.md` → Cooperation
rules). Replace this file's content when a new task starts; record the finished
one in `CHANGELOG.md` and `CHAT_HISTORY.md`.

## Task: Stage 7 design — Fritz cluster integration (research only)

**Goal:** decide how HoMo CFD should submit, monitor, download and delete
STAR-CCM+ jobs on NHR FAU Fritz, based on how CFD-Tool and the team's scripts
do it today.

**Scope now:** written design in `docs/STAGE7_FRITZ.md`; no code that contacts
the cluster, no credentials in the repo.

**Requirements:**
- Read-only study of CFD-Tool (jar classes, not the `p.ppk` key) and the
  supplied `mesh.sh` / `rans.sh` / `post.sh` / `Settings` files.
- Keep the offline/local principle: cluster features must be optional, and the
  viewer must keep working without them.
- Never store passwords or private keys in the repo or in HoMo CFD's settings
  file; reuse the user's existing SSH/PuTTY setup.

**Acceptance:** the user reviews the design and confirms the workflow and the
authentication approach before any implementation starts.

**Status (2026-10-02):** all six questions answered — WinSCP, own accounts,
no `launchV3.sh` (submit with `sbatch mesh.sh`), download after
post-processing, no remote delete, HoMo CFD writes the job scripts, licence
key per user in local settings by default. Final design and build order in
`docs/STAGE7_FRITZ.md` section 5.

**Step 1 built (2026-10-02):** `cluster.py` + `/api/cluster` (GET settings and
WinSCP session names, POST save, POST `cluster/test`) and the **Fritz cluster**
card. First real test reached Fritz but the key has a passphrase → added
**Unlock key with Pageant**. **Confirmed working by the user** after unlocking.

**Step 2 built (2026-10-02):** Simulations on Fritz list (state from job files,
stale detection) and downloads via inProgress → finished. Waiting for the user's
first real download (the six vanished folders were the user's own cleanup). 
**Steps 3–4 built (2026-10-02):** New simulation on Fritz (copy of
`SCRIPT_FABSI`, Settings form, `.sim` upload) and Start (`sbatch mesh.sh` via
the fritz login-node session), live job states. Waiting for the user to choose
the job session and try a real new simulation. Stage 7 is then complete.
Next: step 2, monitor and download for cases in `inProgress`.
