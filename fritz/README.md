# Results table on Fritz (for Termius on a phone)

`homo-table.py` prints HoMo CFD's results table in a terminal on Fritz: one line
per case with its state, CzA, CxA and L/D. On a wide screen (or with `--wide`)
it adds downforce and drag in N, the speed and the age of the last job log.
It reads the same files as HoMo CFD and only reads: nothing is changed, started
or deleted. It needs Python 3.6 or newer, which Fritz's login nodes have.

## Set up once

1. Copy `homo-table.py` into your Fritz folder with the case folders (the one
   HoMo CFD uses as remote folder, e.g. `/home/vault/<group>/<user>`).
2. Log in with Termius (or any SSH app) and add a short command:

   ```sh
   echo "alias ht='python3 /home/vault/<group>/<user>/homo-table.py'" >> ~/.bashrc
   source ~/.bashrc
   ```

## Use

```sh
ht                    # all cases, newest activity first
ht --sort downforce   # most downforce first (also: drag, ld, name, time)
ht 1002_homo_test     # one case in detail: every part's CzA and CxA
ht --wide             # forces, speed and last log also on a narrow screen
```

States: `prep` (not started), `mesh`, `solve`, `wait` (solver done, waiting for
post-processing), `post`, `done`, `FAIL` (post-processing failed). A `?` means
no job log was written for 12 hours: the run has probably stopped.

Downforce = ½ · ρ · v² · (−CzA) and drag the same with CxA, with ρ = 1.18415 kg/m³
and each case's own speed from its `Settings` (`Vehicle State/Velocity`).
