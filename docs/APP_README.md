# HoMo CFD

HoMo CFD shows the team's STAR-CCM+ results on your own computer: a table of
every simulation's coefficients and forces, section images, pressure plots and
the 3D car with streamlines. It can also check, download, create and start
simulations on the Fritz cluster. It runs offline and needs nothing installed:
it brings its own Python.

Questions, bugs, requests: Archit Paneliya, archit.paneliya@voltages.de.

## Start

- **First time:** double-click `Create desktop shortcut.bat` in this folder. It puts
  a **HoMo CFD** shortcut on your desktop.
- **Every time:** double-click the **HoMo CFD** shortcut (or `Start HoMo CFD.bat`).
  HoMo CFD opens in your browser and runs in the background without a window.
- **Stop:** the ⏻ button at the bottom of the sidebar. It also stops by itself
  30 minutes after its last window was closed.

If Windows asks whether to run the file, choose **More info → Run anyway**.

## First start: your results folder

HoMo CFD asks for your **working directory**. First create a folder for your CFD
results, e.g. `D:\HoMo-CFD-results`, with two folders inside: `finished` (one
folder per simulation) and `inProgress` (downloads from Fritz wait there until
they are complete). Choose that folder with **Browse…** or paste its path. A
folder you already use for CFD-Tool works as it is.

## Updates (SVN)

This folder comes from the team's SVN. To get a new version:

1. Quit HoMo CFD with ⏻ (while it runs, Windows locks some of its files).
2. **SVN Update** this folder.
3. Start it again.

Please don't change, add or delete files in this folder (your next update would
conflict), and never put results here. HoMo CFD keeps your own settings outside
this folder, in `%APPDATA%\HoMo-CFD`, so updates keep them.

## Using it

- **Results table:** every simulation's final coefficients, with Downforce [N] and
  Drag [N] at the speed you set above the table. Click a column header to sort;
  ☆ before a name highlights its row; **Δ vs reference** shows differences to one
  simulation; **Customize columns** renames, hides and reorders columns (drag them
  by the grip).
- **Results tree** (left): section images (comparison window for up to 4 cases),
  pressure plots, 3D scene pictures, **Residuals** (residuals, CzA and CxA from
  the solver log; compare up to 4 simulations) and **3D-data · 3D viewer** for
  the 3D car.
- **3D viewer:** field, palette, view; streamlines (choose how many and where they
  start), vortices and surface flow (tick them; they start off). Point at the car or a
  streamline to read the value there; the box at the top right shows the case's
  coefficients.
- **Cluster** (bottom of the sidebar): connect to Fritz through your WinSCP saved
  session. Then **Simulations on Fritz** shows every case's state with Download
  and Start, **Results on Fritz** shows their coefficients before downloading, and
  **New simulation on Fritz** creates a case from the template.

## Also in this folder

- `starccm/`: the STAR-CCM+ macros for the 3D export and for swapping in new parts
  from CAD files; see `starccm/README.md`.
- `fritz/`: a results table for the terminal on Fritz (e.g. Termius on a phone);
  see `fritz/README.md`.
- `ABOUT.txt`: version and background.
