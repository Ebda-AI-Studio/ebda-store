# LOOKS-10

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-10 — `applyLook` is not atomic across the builder step and the store update, and that is accepted. Evidence: `/stores/:id` routes run under `storeScopeContext` with no request transaction (each query is its own transaction), so the order is builder first (a refusal throws before any store write), then the store update; a publish only happens for an untouched store (nothing to lose) and, if the store update then fails, a retry converges (the store is no longer fresh, so it takes the draft path). Cost if wrong: a rare failed store update leaves the new family live under the old look until retry.
