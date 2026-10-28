Ruling BUNDLE-BUDGET-4 - API Worker bundle trimmed by turning on `minify` (plus `upload_source_maps`) in `apps/api/wrangler.jsonc`; `bundleBytes` 15,500,000 -> 8,300,000 and `bundleGzipBytes` 3,400,000 -> 2,400,000 in `scripts/ci/worker-startup-budget.json` (new size + 10%). The startup-CPU gate (140 ms absolute, ratio 0.25 + 15 ms on PRs) is UNCHANGED. Closes the post-launch trim task of BUNDLE-BUDGET-3.

Measured 2026-10-28 with `scripts/ci/worker-startup-budget.mjs --runs 5` (local workerd, same worktree, generated Prisma client):

|                        | before     | after            |
| ---------------------- | ---------- | ---------------- |
| `worker.js` bytes      | 14,288,016 | 7,518,999 (-47%) |
| gzip bytes             | 3,005,070  | 2,171,018 (-28%) |
| startup CPU (min of 5) | 91.6 ms    | 99.2 ms          |

Why minify and not dependency surgery: the esbuild source-map attribution of the 13.4 MB unminified bundle was ~5.8 MB first-party code and ~5 MB npm, with no single dead dependency worth more than ~0.3 MB. Dynamic `import()` does NOT shrink a Worker bundle (wrangler bundles to one file; `lib/lazy-modules.ts` only defers evaluation, it ships the same bytes). Aliasing `exceljs` to its Node build (`exceljs/lib/exceljs.nodejs.js`) was tried and made the bundle LARGER (14.11 vs 13.36 MB at the time), so it was dropped. Minify halves the bundle with no code change; wrangler keeps function and class names (`keep_names`), and Durable Object / entrypoint exports are untouched.

Trade-offs: startup CPU read ~8 ms higher (within the 140 ms ceiling; one measurement run on a laptop, so partly noise; CI's same-job relative gate against main is the judge). Stack traces are minified; `upload_source_maps` lets Workers Observability de-minify them, Sentry has no maps uploaded for the Worker (unchanged: it had none before, and unminified lines were already bundle lines, not source lines).

Not verified: the four workerd suites that import `@ebda/shared` (`auth-state`, `db-scope`, `entry`, `queues-cron-realtime`) fail in this worktree on the UNMINIFIED bundle too (`TypeError: Cannot read properties of undefined (reading 'string')` at `packages/shared/src/index.ts:12`, environment), so they could not prove the minified Worker end to end; the other 4 suites (19 tests) pass on both, and the startup script boots the minified Worker in workerd. CI's `Worker dry-run (api)` + pre-deploy smoke (Ruling DEPLOY-SAFETY-1, boots the built Worker against Postgres) is the gate for the rest.

Cost if wrong: a name- or order-sensitive dependency breaks only under minification; the pre-deploy smoke refuses such a Worker and the post-deploy probe rolls back (DEPLOY-SAFETY-2). Revert = drop the two lines in `wrangler.jsonc` and restore the 15.5 MB / 3.4 MB budget.
