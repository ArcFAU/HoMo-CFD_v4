# HoMo CFD

Web viewer for Formula Student STAR-CCM+ postprocessing results. This is a modern replacement for the existing CFD-Tool (PNG sections + later CSV plots and four-case compare).

## Run

This machine does not need Node. Python 3 is enough.

```bash
py serve.py
```

Open http://127.0.0.1:5173 in Chrome or Edge. Choose the results root once with **Open folder**; HoMo CFD remembers it when browser permissions allow. The workspace shows one collective table with each simulation's final coefficients iteration; coefficient values use three decimal places. Use **Customize columns** to rename, hide, or reorder columns; preferences are saved in this browser, and each value remains bound to its CSV header. Click an image section to open a new comparison window seeded with that simulation. Use **Add case** inside the window to bring in more simulations; each panel has independent field and axis controls. Zoom and pan are synchronized automatically; **Sync images** synchronizes frame stepping. Allow pop-ups for the local app.

## Keep ChatGPT in sync

1. Paste `HANDOFF_FOR_CHATGPT.md` into ChatGPT once.
2. After Cursor changes something, paste `STATUS.md`.
3. Spec lives in `SHARED_CONTEXT.md` — correct that file if the aero workflow is wrong.
