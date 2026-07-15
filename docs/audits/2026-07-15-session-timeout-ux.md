# Session-Timeout UX Audit — Lens S (2026-07-15)

**Source:** Instagram reel Daxv0QLgG8B ("your security settings are kicking users out
every 15 minutes"). Distilled thesis: (1) idle must mean absence of MEANINGFUL
activity (form submits, clicks, API calls, navigation — not mouse-move; sustained
reading ≠ idle), (2) warn 60s before hard expiry, (3) preserve state on
re-authentication — return the user exactly where they were, never the home page.

**Scope:** force-website-builder @ origin/main (post-#731). Fixes on branch
`fix/session-timeout-ux`.

## Verdict

FWB's session architecture already dissolves the reel's core complaint: a 30-min
access JWT with **transparent single-flight refresh-on-401** and a 365-day rotating
refresh token means active users are never idle-kicked at all (S1 structurally
clean) and there is no hard idle expiry to warn about (S2 N/A). The gaps were both
in S3 — state preservation on the rare real kick (refresh-family revocation,
logout-elsewhere, reuse-detection trip).

## Tally: 0 Critical · 0 High · 1 Medium · 2 Low

### MEDIUM

**M1 — Admin session kick loses the merchant's location.**
`apps/admin/src/lib/auth.tsx` pushed a bare `/login` on auth failure and both login
paths (password + MFA) landed on `/` — a merchant kicked mid-workflow (product
editor, order detail) re-authenticated into the dashboard and had to re-navigate.
_Fix:_ the kick now carries `?returnTo=<pathname+query>`; `postLoginDestination()`
honors it on both the password and MFA landings, validated internal-only (rejects
`//` protocol-relative and `/login` loops). Intentional `logout()` still lands on a
bare `/login` by design.

### LOW

**L1 — Two storefront login links missing `?redirect=` (defect class).**
`LoginClient` has supported a validated `?redirect=` param all along, and 4 sibling
call-sites use it (account layout, addresses, profile, wishlist) — but
`components/ReviewSection.tsx` (PDP "log in to review") and
`app/returns/ReturnsClient.tsx` (returns page) sent users to bare `/auth/login`,
landing them on home instead of back on the product/returns page.
_Fix:_ both now pass the redirect param (ReviewSection uses the live pathname;
Returns uses `/returns`).

**L2 — No unsaved-form draft preservation on long admin editors (flagged, not
built).** If a kick happens on an unsaved product edit, the returnTo fix restores
the LOCATION but not the FORM CONTENT. Building autosave-drafts (localStorage keyed
per store+form) is a feature investment — recommended for the product editor first,
but it is a product decision, so it is flagged here rather than silently built or
silently dropped.

## Already-passing lens items

- S1 meaningful-activity idle: no idle timers exist at all; session continuity rides
  on real API usage (every request refreshes transparently). Nothing keys on
  mouse-move.
- S2 warn-before-kill: N/A — transparent refresh means no hard expiry mid-use; the
  refresh family only dies on explicit revocation or 365d absence.
- Guest cart / checkout state: cart persists in per-store localStorage and syncs on
  login (existing behavior).
