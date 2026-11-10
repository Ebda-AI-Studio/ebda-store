# Review fix-after items before launch (2026-11-10)

Goal: clear the "fix after" items the reviews of PRs #510, #511 and #512 left, and the R20 data cleanup, before launch.

## Finish line

- What must work: each review-flagged test fails on the real defect; the marketing Menu start button renders the same at every width without depending on stylesheet order; an English SEO title that names the brand in Arabic is kept; D1 and every StoreDO accept only the five current templates.
- Exercised: the touched unit tests, each with a mutation that turns it red; a built marketing `out/` in Playwright at 360/390/440px in Arabic and English; a local D1 (`wrangler d1 migrations apply --local`) and the workerd Durable Object suite.
- Must NOT change: what any storefront, marketing page or store renders; no production write from this branch.
- Done: an open PR with green checks, not merged, not deployed.

## Items

1. Weak tests from the #510 review, each now shown red by a mutation:
   - manifest link: the rendered `<link rel="manifest">` href per locale (Next's own head renderer) in `tests/unit/storefront-head-metadata.test.ts`; the `layout.tsx` source grep in `manifest.webmanifest/route.test.ts` is gone. Red: the layout passing `null` to `manifestHref`.
   - `/auth/me` on the review form: `tests/unit/storefront-review-section-auth-gate.test.tsx` renders `ReviewSection` with and without the session hint and counts the requests. Red: the gate removed.
   - form-control font size: the size that APPLIES at phone width per control (utilities beat a component rule, a `max-*:` variant beats a plain one, a conflict counts as the smaller size, an unresolvable className is reported). Red: `search-input text-sm` on the products filter (the old test passed it).
   - session refresh gates: the probe mock answers `/auth/me` (401) and `/auth/refresh` (400 no token) differently and asserts each was hit once; a refresh-succeeds case is added. Red: a no-session refresh treated as refreshed (the old test passed it).
2. `.nav-menu .menu-start` (an `<a>` since #511): globals.css hides it only from 800px, chrome.css shows it as flex up to 799px; the ranges never overlap. `tests/unit/marketing-menu-start-display.test.ts` checks the ranges (red on the old CSS). A computed-style fingerprint of the header and open Menu from a built `out/` is identical before and after.
3. Ruling SEO-LANG-SHARE-1: an English field is Arabic only when more than half of its letters are Arabic.
4. Ruling SKIN-DEL-9: D1 `0009_store_template_current.sql` and StoreDO `0004_template_current.sql` (data remap + refusing triggers, no table rebuild). Applied only by the deploy (`cf-api-deploy.yml`, `wrangler d1 migrations apply ebda-platform --remote`) and each StoreDO's next start. Rollback in `docs/ROLLBACK.md`.
5. Sweep: two identical-branch ternaries fixed (`tests/unit/refund-settle.test.ts` race test now sends each caller's real shape; `tests/unit/region-money.test.ts` noise removed). Twenty source-position assertions in 16 other test files remain (see the PR body); Ruling REVIEW-FU-1 below.

## Rulings

- Ruling REVIEW-FU-1 - the 20 remaining `src.indexOf(a) < src.indexOf(b)` source-order assertions in 16 `tests/unit` files are listed, not rewritten, in this PR: each needs its own behavioural harness (queues, refunds, erasure, MCP limiter order), which is a separate change per area, and none of them was named by a review. Cost if wrong: a reordering that keeps the text order but changes control flow passes one of those tests until it is rewritten.
