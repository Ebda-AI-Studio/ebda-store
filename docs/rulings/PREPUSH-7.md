# PREPUSH-7

> Section: 2026-11-17 — track1 class fix after #887 (branch `fix/prepush-router-walkers`)

**Ruling PREPUSH-7: a unit test that loads the whole API router (`@api/routes`) counts as a scanner, so it runs on every
push.**

`route-table-manifest`, `auth-sensitivity-routes` and `public-mount-admin-route-guard` each load the full Express router
with a dynamic `import('@api/routes')` and check its route table. Two separate gaps kept them out of the local gate:

- `vitest related` follows only static imports, so a changed `*.routes.ts` never reached them.
- On a push wider than 6 files, `related` is skipped entirely (PREPUSH-4).

So a new route went green locally and red in CI, on #811 and again on #887 (the `route-table.json` manifest was stale).

`SCANNER_RULE` (`scripts/ci/pre-push-plan.mjs`) now also matches the `'@api/routes'` module string. It does not match an
import of one routes file. The three tests join the scanner set (214 → 217) and take about 3 s each under the scanner
slot and pass cache. A docs, tests or i18n-only push still narrows them away (PREPUSH-6), which is correct because such a
push cannot change the router.

Cost if wrong: about 10 s more on a non-light push; CI still runs them either way.
