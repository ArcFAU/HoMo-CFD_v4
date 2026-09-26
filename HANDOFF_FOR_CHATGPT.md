# Paste this into ChatGPT

I am building **HoMo CFD** in Cursor as well as with you, so I do not want to re-explain the project to each of you.

Cursor has the full thread summary in the repo file `SHARED_CONTEXT.md`. Please treat that file as the spec.

**Division of labor**

- You (ChatGPT): product / aero / UI decisions, and review of whether the app matches Formula Student postprocessing.
- Cursor: write and run the code in `C:\Users\Archit\HoMo-CFD`.

**Where we are**

- Stage 0 is still missing a real `Velocity_x-Section` file listing, `PressureDistributions` listing, sample PNGs, and a CSV.
- Cursor already started Stage 2: `py serve.py` then http://127.0.0.1:5173. Vanilla HTML/JS (this PC has Python, not Node). Open a result folder, parse `{Field}_{axis}-Section`, display images with field / axis / position controls.
- V1 is still: modern CFD-Tool (up to four cases, PNGs, CSVs, synced section slider). Not ParaView. Not Fritz submit yet.

**Please do this on your next reply**

1. Acknowledge Cursor is the implementation partner and stop asking me to restate the workflow unless something in `SHARED_CONTEXT.md` is wrong.
2. Tell me exactly which sample files you still need (smallest possible set).
3. Specify Stage 3 UI in enough detail for Cursor to implement four-case compare without guessing (layout, what stays synced, what can differ per case).
4. If I paste `STATUS.md` later, update your plan from that instead of restarting from zero.

If anything in the shared context is wrong, list the corrections first. Do not dump a full rewrite of the app.
