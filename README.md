# HoMo CFD

Web viewer for Formula Student STAR-CCM+ postprocessing results. This is a modern replacement for the existing CFD-Tool (PNG sections + later CSV plots and four-case compare).

## Run

This machine does not need Node. Python 3 is enough.

```bash
py serve.py
```

Open http://127.0.0.1:5173 in Chrome or Edge. Click **Open case folder** and choose one postprocessing result directory.

## Keep ChatGPT in sync

1. Paste `HANDOFF_FOR_CHATGPT.md` into ChatGPT once.
2. After Cursor changes something, paste `STATUS.md`.
3. Spec lives in `SHARED_CONTEXT.md` — correct that file if the aero workflow is wrong.
