# CI-ROUTE-1

> Section: 2026-11-04 (branch `ci/per-pr-runner-label`)

Ruling CI-ROUTE-1 - A pull_request labelled `ci-umbra` runs EVERY job of every PR workflow (ci, gitleaks, blast-radius, deploy-change-label, cf-schema-current) on the Umbra runners `["self-hosted","umbra-ebda"]`; all other PRs and every push/schedule event keep `fromJSON(vars.EBDA_RUNS_ON || '"ubuntu-24.04"')`. setup-node `cache:` follows the same decision (remote Actions cache only when the job runs hosted). Ahmad 2026-11-04: route a whole PR to one place, never split one PR's jobs. Add the label BEFORE the push (or re-run the workflow after labelling); `labeled`/`unlabeled` are deliberately not triggers, to avoid re-running CI on every label change. Cost if wrong: a labelled PR waits if Umbra is down - remove the label (and re-run) to go hosted.

> SUPERSEDED 2026-11-18 (Ruling NO-HOSTED-RUNNERS-1 and its follow-up): Umbra was retired 2026-11-14, so the `ci-umbra` PR-label route and its `umbra-ebda` runner label are removed from every workflow; `tests/unit/workflow-hosted-runners-only.test.ts` fails if either reappears. This text is kept as history.
