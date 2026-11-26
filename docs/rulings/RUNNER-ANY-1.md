# RUNNER-ANY-1 - light jobs may run on any runner

Ruling RUNNER-ANY-1 - the four self-hosted runners (ids 6, 7 heavy `ebda-mac`; ids 8, 9 light `ebda-mac-light`) also carry the shared label `ebda-mac-any`, and the repo variable `EBDA_LIGHT_RUNS_ON` is `["ebda-mac-any"]`. Evidence: light runners were starved while the heavy runners sat idle (2026-11-17/18). Cost if wrong: a light job occupies a heavy runner for a few minutes; rollback below.

- Label added server-side with `POST orgs/Ebda-AI-Studio/actions/runners/{id}/labels` (no re-register).
- The main-first lease must see the label before any job uses it: `MAIN_FIRST_LEASE_LABELS="ebda-mac ebda-mac-light ebda-mac-any"` in `~/.ebda-os.local.env` (verified with a fresh `main-first.sh --dry-run`). The merge controller's `window.sh` label lists need the same label.
- Heavy jobs stay on `EBDA_RUNS_ON` (`ebda-mac`); only the light tier moves.
- Follow-up (foundation): sub-2-minute jobs read `vars.EBDA_ANY_RUNS_ON || vars.EBDA_RUNS_ON`; OS layer/brain/hands stay on their own runners; the lease default moves into foundation with a test.
- Rollback: `gh variable set EBDA_LIGHT_RUNS_ON -R Ebda-AI-Studio/ebda-store --body '["ebda-mac-light"]'`.
