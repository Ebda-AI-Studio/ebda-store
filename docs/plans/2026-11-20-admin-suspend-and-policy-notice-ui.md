# Super-admin suspend control + policy page how-to (QA-80, QA-81)

Finish line: a super admin can suspend (with a required reason) and reinstate a store from every place the UI offers it,
the merchant appeal path is exercised end to end, and the Policy updates page says how a version is published.

## Findings (code, 2026-11-20)

- Suspend existed in THREE super-admin surfaces (store dashboard, Settings, Features), each its own copy, none asked for a
  reason although `PATCH /api/v1/stores/:id/status` takes `reason` (A13) and the playbook already said to type one. The
  dashboard offered Suspend only for `active`, so an `inactive` store (the QA store) showed Activate only. The dashboard
  discarded API errors.
- Backend needs nothing: reason row, audit, appeal close on reinstate, cache bust are in `store.routes.ts`.
- `/policy-updates` is not read-only: Send notice / Resume / Retry exist. A row only shows Send notice when its version has
  `material: true`; all four current versions are `material: false`, so nothing was offered. Versions come from
  `LEGAL_POLICIES` (code, deploy), by design (no policy CMS).

## Change

1. `components/store-status/StoreStatusControl.tsx`: the one suspend/reinstate writer (required reason, in-page confirm, error
   shown, appeals link); the three surfaces render it. Old `SuspendStoreModal` and three inline copies removed.
2. Policy updates: a how-to card at the top; no new action (backend send exists; non-material versions are not announced).
3. Tests: control unit tests; DO-backend step extended (reason -> merchant reads it -> appeal -> listed in trust requests);
   `store-operational` unit test (suspended refuses money-out and customer sends); runbooks updated.
