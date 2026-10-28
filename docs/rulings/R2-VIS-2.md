# R2-VIS-2

> Section: 2026-10-01 — backlog batch z-ci-other (branch `fix/backlog-z-ci-other`)

**Ruling R2-VIS-2 — an UNKNOWN catalog estimate passes only when the bypass is proven positively
(issue 2354; amends R2-VIS-1).** The UNKNOWN (`reltuples` -1) refusal had no way out for the role it
gates: post-cutover the earlier app role does not own the STRICT tables, so the guard's ANALYZE is skipped
with a WARNING, and a table that has never had a row is never auto-analyzed — a standing weekly p1
and a sweep that never cleans. The guard now reads `current_setting('app.bypass_rls', true)` inside
the SAME runner the collection used; every STRICT policy admits all rows under it (pinned by
`rls-ebda-app.test.ts`), so with the bypass proven a 0 is a real 0 and UNKNOWN passes. Positive
catalog evidence (`reltuples > 0` or `n_live_tup > 0`) still refuses, bypass or not; without the
bypass proven, UNKNOWN still refuses. `scripts/r2-orphan-audit.ts --force-report` prints a refused
dry-run list under a NOT-TRUSTWORTHY banner and is ignored with `--apply`. Verified against a real
Postgres with a non-superuser owner and a non-owner role (the non-owner's ANALYZE really leaves
`reltuples` at -1). No ownership grant or SECURITY DEFINER helper was added: the positive proof
makes it unnecessary. Cost if wrong: a STRICT table whose policy lost its bypass clause reads 0
under a set GUC and its references are treated as orphans — the policy test is the guard for that.

**Issue ownership after #2309 merged mid-batch.** Issue 2010 (masked payment key is a ciphertext
fragment) is fixed by open PR #2311 (`Fixes #2010`), which must first rename its
`20261001120000_payment_config_key_fingerprint` migration under MIG-ORD-1. Issue 2281 was closed
by #2309 (its own ruling I18N-G2 keeps the PWA name unlocalized), so this batch's overlapping i18n
commit was dropped on rebase. Issue 2312 became fixable on main once #2309 landed. This batch fixed it, and batch y-web-admin
(#2334) fixed the same class in parallel (issues 2313/2322/2323, Ruling YWA-1) with a per-theme
resolver that also bans the malformed `/30/30` and off-scale `/8` spellings. On merging main, #2334's
gate and `design.md` wording were kept and this batch's detector was dropped — one gate, not two; the
pill sweeps agree (every dark half on `-ink`).
