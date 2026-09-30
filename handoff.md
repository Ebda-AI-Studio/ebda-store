# Handoff — backlog batch final (the last 22 open FWB issues)

_Updated 2026-10-01. Branch `fix/backlog-final`, worktree
`_worktrees/force-website-builder__fix-backlog-final`, off `origin/main` @ 0e17786c._

## Goal

Triage and close the 22 `audit-followup` issues in `~/.claude/fwb-lane/batches-1003/final.tsv`,
one PR, under the owner rules: nothing on pecannbee changes visually; admin + orders colour
changes approved; email logo capped; audit tooling diffs from the merge base.

## Current state

All code, tests and docs written; unit (5324), app (1220), typecheck and lint green locally.
One PR `fix(p2): backlog batch final`. Not deployed.

## Done

- Fixed (16): 2356 (last-touch recovery stats, relabelled), 2355 (post-merge migration-order arm),
  2354 (R2 guard proves the bypass; `--force-report`; real-Postgres test), 2353 (bounded
  dead-letter lists, /email-queue section, SMS alert), 2352 + 2338 (three-dot audit/blast-radius
  diffs), 2351 + 2350 (flatten script: split cache purge, in-transaction snapshot), 2348 (rollup
  fan-out), 2347 (sweep wall-clock budget + paged resolutions), 2344 (per-product supplier memo),
  2343 (pinned sale chip vs top custom chip; legacy corner frozen), 2342 (dead `/8` classes removed
  pixel-identically; dropped-class gate on web + ui), 2341 + 2332 (`-ink` everywhere in admin +
  orders, gate per app/theme/state), 2336 (email logo 160×64 box).
- Closed as already fixed on main (3): 2340, 2339, 2287.
- Rulings: MIG-ORD-1 amended, ACR-1a, R2-VIS-2, SVF-4, YWA-TXT-1, OD-9e, BF-1..3 (docs/RULINGS.md).

## In progress

Nothing.

## Left to do

- Owner questions (issues left open with a comment): 2345 / 2346 (old-shape variant-less PO lines:
  how they count on order, how stranded `partial` units + AP are settled) and 2349's storefront
  half (re-colour cart/checkout/auth banners on apps/web — touches pecannbee).
- Branch protection "require branches to be up to date" on main (prevention for the migration
  race; the new CI arm only detects) — a repo setting, owner's call.
- After merge + deploy: verify `/email-queue` renders the corrupt section only when non-empty, and
  one real email's logo in Gmail.
