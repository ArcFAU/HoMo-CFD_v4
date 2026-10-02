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

**Status (2026-10-02):** draft written — `docs/STAGE7_FRITZ.md`. Answered so
far (section 4): own Fritz account per user; download after post-processing
(`plots/DONE` comes too early). Still open: connection method, `launchV3.sh`
(user did not know it; check the team's Fritz `Pipeline` folder), remote
clean-up, job-script generation, licence key. Nothing contacts the cluster yet.
