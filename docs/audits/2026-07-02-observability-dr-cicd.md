# FWB Deep Audit — Observability / DR / CI-CD / Environments (2026-07-02)

**Scope:** Read-only production audit. Lens = observability, alerting, CI/CD, migrations, environments, disaster recovery.
**Worktree:** `force-website-builder__fix-deep-audit-2026-07-02` @ `origin/main` HEAD `2332c4d5`.
**Method:** Read actual workflow YAMLs, `Dockerfile.api`, `railway.json`, `DEPLOYMENT.md`, `docs/ROLLBACK.md`, `scripts/`, `apps/api/src/index.ts`, Sentry wiring across all four apps. Cited `file:line`. Verdicts: CONFIRMED (verified in code/config) vs PLAUSIBLE (strong signal, not fully proven in this pass).

**Overall:** The observability + alerting + DR posture is genuinely strong — five-channel observability, Telegram P0 bridge with boot-time token guards, dual-layer DB backup, migration-before-deploy via Railway `preDeployCommand`, retired Neon snapshots. The real gaps are in (1) the **Orders PWA having zero Sentry**, (2) **Sentry source maps never uploaded** (no `withSentryConfig`), (3) the **legacy `deploy.yml`** violating multiple CI/CD-standard rules (no timeouts, no concurrency, migrate-AFTER-deploy on a pooled URL), (4) **massive branch sprawl** (242 branches), and (5) **DEPLOYMENT.md drift** (describes Vercel-Hobby-only while `cf-deploy.yml` auto-ships to Cloudflare Workers on every push).

---

## Critical

_None._ No finding rises to production-down / data-loss certainty. The nearest candidates (deploy.yml migrate-after-deploy, orphan branches tripping gitleaks) are bounded to a dormant workflow and CI noise respectively.

---

## High

### H1 — Orders PWA ships to production with NO Sentry error capture

**Verdict:** CONFIRMED
**Where:** `apps/orders/` — no `sentry` dependency in `apps/orders/package.json`, no `instrumentation.ts` / `instrumentation-client.ts` / `sentry.*.config.ts` anywhere under `apps/orders/`. The only `sentry` reference is the CSP `connect-src` allowlist in `apps/orders/next.config.js:82` (allowlisted but nothing sends).
**Gap:** `apps/web` and `apps/admin` each have full Sentry wiring (`sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts`, `instrumentation-client.ts`). The Orders PWA — the surface store staff use to run live fulfillment — is deployed to `orders.force-ai.co` via `cf-deploy.yml` with no client OR server error capture. A crash in the fulfillment UI is invisible; it will never reach the Sentry dashboard or the Telegram bridge. DEPLOYMENT.md §Observability "Sentry — code threw" lists only three projects (api/web/admin) and silently omits orders.
**Fix:** Add `@sentry/nextjs`, an `instrumentation-client.ts` (client, survives OpenNext), and `NEXT_PUBLIC_SENTRY_DSN_ORDERS` wired in `cf-deploy.yml`'s `deploy-orders` env block (currently only writes `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID` + VAPID). Mirror the web app's pattern. Update DEPLOYMENT.md §2 to "four Sentry projects."

### H2 — Sentry source maps are never uploaded (no `withSentryConfig`) → minified stack traces in prod

**Verdict:** CONFIRMED
**Where:** `apps/web/next.config.js:165` → `module.exports = nextConfig;` (bare). `apps/admin/next.config.js:152` → `module.exports = withNextIntl(nextConfig);` — neither is wrapped in `withSentryConfig(...)`.
**Gap:** Without the Sentry webpack/build plugin (which `withSentryConfig` installs), no source maps are uploaded and no release is created. Every Sentry issue from the storefront and admin arrives with **minified/obfuscated stack traces** and no release/commit association, badly degrading the "code threw" channel's actual usefulness for triage. `instrumentation-client.ts` correctly notes it moved init OUT of `sentry.client.config.ts` precisely _because_ `next.config.js` "was NOT wrapped in `withSentryConfig`" — confirming the wrap is intentionally absent, which fixes client-init but leaves the source-map gap open.
**Fix:** Wrap both configs in `withSentryConfig` with `sourcemaps` upload + `SENTRY_AUTH_TOKEN` in the CI build env (Vercel + `cf-deploy.yml`). Verify releases appear in Sentry with readable frames. Confirm the CF/OpenNext build still succeeds (the plugin runs at build time, unaffected by the `instrumentation.ts` move-aside).

### H3 — Branch sprawl: 242 branches incl. orphan `auto-fix/*` — violates branch-hygiene standard + widens gitleaks/secret surface

**Verdict:** CONFIRMED
**Where:** `git branch -a` → 242 branches; includes `auto-fix/1d70f6db`, `auto-fix/472a79e4`, `auto-fix/63cd498e`, `auto-fix/8aeee2c1`, `auto-fix/b0fd5429`, `auto-fix/c8eaa251`, plus dozens of stale `feat/*`, `docs/*`, `chore/*`, `ci/*`.
**Gap:** The CI/CD standard (`feedback-force-ai-ci-cd-standard.md`) mandates "only `main` + `preview` if staging active, no `auto-fix/*` orphans" because the gitleaks workflow historically scans branch history and orphans containing old credentials trip CI even after main is scrubbed. 242 branches is far past hygiene; the watchdog's `auto-fix/*` orphans are exactly the collision/orphan class the worktree-orchestration rule warns about.
**Fix:** Run `~/.claude/scripts/worktree-cleanup.sh` + delete merged/stale branches (`git branch --merged origin/main`). Confirm the auto-fix watchdog uses its own worktree and prunes its branches. Target: `main` + any genuinely-active feature branch only.

---

## Medium

### M1 — Legacy `deploy.yml` violates 3 CI/CD-standard rules: no `timeout-minutes`, no `concurrency`, migrate-AFTER-deploy on a pooled URL

**Verdict:** CONFIRMED
**Where:** `.github/workflows/deploy.yml` — 6 jobs, **0** `timeout-minutes`, **0** top-level `concurrency`. `migrate` job at L121-142: `needs: [deploy-production]`, `if: always() && needs.deploy-production.result == 'success'` (runs migrations _after_ the app is already live), and uses only `DATABASE_URL: ${{ secrets.DATABASE_URL }}` (L142) with **no `DIRECT_URL`**.
**Gap:** Three standard violations at once: (a) anti-hang rule — every job must have `timeout-minutes`; (b) superseded-run rule — no `concurrency` group; (c) migrate-before-deploy rule — this migrates AFTER promoting the new app, the inverse of `railway.json`'s correct `preDeployCommand` ordering. If `secrets.DATABASE_URL` is the pooled PgBouncer URL, `prisma migrate deploy` can fail (Neon pooled needs `DIRECT_URL` — see `feedback-neon-pooled-needs-pgbouncer-and-direct-url`). This workflow is largely **dormant** (triggers on `v*` tags / manual; `git tag` returns 0 tags, so it's never fired), which is why it hasn't bitten — but it's a live footgun for any future tag-based release and contradicts the canonical path.
**Fix:** Either delete `deploy.yml` (Railway auto-deploy + `cf-deploy.yml` are the real paths) or bring it to standard: add `timeout-minutes` to all jobs, a top-level `concurrency` block, move `migrate` to run BEFORE `deploy-production` (or rely solely on Railway `preDeployCommand`), and add `DIRECT_URL` to the migrate step.

### M2 — DEPLOYMENT.md architecture is stale: describes "Vercel Hobby" only; `cf-deploy.yml` auto-ships to Cloudflare Workers on every push to main

**Verdict:** CONFIRMED
**Where:** `DEPLOYMENT.md:26` ("VERCEL Hobby (free)") + §2 + Cost Summary table (L321-328, "Vercel Hobby $0"). Contradicted by `.github/workflows/cf-deploy.yml:1-38` — auto-deploys web/admin/orders to Cloudflare Workers (OpenNext) on every push to `main` to `store.force-ai.co` / `admin.force-ai.co` / `orders.force-ai.co`. Also contradicts global memory: Vercel is **paid Pro**, not Hobby.
**Gap:** The canonical deploy topology doc omits the live Cloudflare Workers deploy pipeline entirely and mis-states the Vercel plan. During an incident, a responder reading DEPLOYMENT.md would look at Vercel dashboards while the actual traffic may be served by CF Workers — the exact "misled incident responders" failure the doc's own 2026-05-22 header warns about. Violates the documentation-parity rule.
**Fix:** Rewrite the Architecture Overview + Cost Summary to reflect the dual (or in-progress cutover) Vercel↔Cloudflare topology, mark which host is authoritative for each app today, and correct "Hobby" → "Pro". Cross-link `docs/migration/cloudflare-cutover-runbook.md`.

### M3 — Server-side Sentry inactive on the Cloudflare Workers target (SSR/RSC throws not captured)

**Verdict:** CONFIRMED
**Where:** `apps/web/instrumentation.ts` header comment: "scripts/cf-build.sh moves THIS file aside for the OpenNext build … so SSR-side Sentry is currently inactive on the Cloudflare Workers target." Confirmed `cf-build.sh` manipulates instrumentation.
**Gap:** On the CF Workers deploy (now the auto-deploy target per `cf-deploy.yml`), SSR / server-component / route-handler errors are NOT captured — only the client hook (`instrumentation-client.ts`) survives. As CF becomes the primary host, an entire class of server errors goes dark. Self-documented as a follow-up needing `@sentry/cloudflare`, but not yet tracked as a gating item against the cutover.
**Fix:** Adopt `@sentry/cloudflare` for the OpenNext worker (or a Worker-level `onError`) before completing the CF cutover; until then, treat CF as reduced-observability and keep Vercel as the SSR-error-capturing host. Add to the cutover runbook's exit criteria.

### M4 — Missing `timeout-minutes` / `concurrency` across several scheduled + security workflows

**Verdict:** CONFIRMED
**Where:** `gitleaks.yml` (0 timeout, 0 concurrency), `cloud-rescue.yml` (0/0), `lighthouse-nightly.yml` (0/0), `load-test-nightly.yml` (0/0), `zap-baseline.yml` (has timeout, 0 concurrency), `preview-env-isolation.yml` (has timeout, 0 concurrency), `neon-snapshot.yml` (0/0, but retired to `workflow_dispatch` so low impact). `ci.yml` and `cf-deploy.yml` are the good exemplars (full timeouts + concurrency).
**Gap:** Anti-hang + superseded-run rules from the CI/CD standard aren't uniformly applied. A hung gitleaks/ZAP/lighthouse run can burn self-hosted runner minutes indefinitely; back-to-back schedule ticks can stack.
**Fix:** Add `timeout-minutes` to every job (gitleaks=8, zap=15, lighthouse=20, load-test=30, cloud-rescue=10) and a top-level `concurrency` group with `cancel-in-progress: true` to each.

### M5 — gitleaks install uses `sudo tar` but the workflow defaults to the self-hosted runner (which "can't sudo")

**Verdict:** CONFIRMED (inconsistency) / PLAUSIBLE (runtime failure)
**Where:** `gitleaks.yml:31` → `| sudo tar -xz -C /usr/local/bin gitleaks`, while `gitleaks.yml:20` routes to `self-hosted` by default (`vars.USE_SELF_HOSTED`). Contrast `ci.yml:463-476` + `preview-env-isolation.yml:55-64`, which explicitly install jq to `$HOME/.local/bin` _without_ sudo, commenting "self-hosted runner may lack it + can't sudo."
**Gap:** The rest of the repo's self-hosted steps deliberately avoid `sudo`; gitleaks assumes it. If the WSL2 self-hosted runner lacks passwordless sudo, the secret scan silently fails to install and the job errors (or worse, is skipped) — the secret-scanning gate becomes unreliable exactly where it matters.
**Fix:** Install gitleaks to a runner-owned PATH dir without sudo (mirror the jq pattern), or pin the job to `ubuntu-latest` (secret scan is cheap and benefits from fail-open cloud availability like `notify-failure`).

### M6 — gitleaks scans only the pushed ref, not all branches — orphan-branch leaks can hide

**Verdict:** PLAUSIBLE
**Where:** `gitleaks.yml:34-35` → `gitleaks detect --source . --config .gitleaks.toml` on `push: [main]` + `pull_request`, with `fetch-depth: 0`. `.gitleaks.toml` + `.gitleaksignore` both present (good).
**Gap:** `fetch-depth: 0` fetches full history of the _checked-out_ ref, but `gitleaks detect` scans commits reachable from HEAD — not the 242 other branches. The CI/CD standard specifically calls out scanning ALL branches because orphan branches (e.g. the `auto-fix/*` set) can carry old credentials that main-only scans miss. Combined with H3's branch sprawl, a leaked secret on a stale branch would go undetected.
**Fix:** Either reduce branch count (H3) so the surface is trivial, or add a scheduled all-branches scan (`git fetch --all` + `gitleaks detect --log-opts="--all"`).

---

## Low

### L1 — `Dockerfile.api` CMD also runs `prisma migrate deploy` (double-migrate / multi-replica race risk)

**Verdict:** PLAUSIBLE (bounded)
**Where:** `Dockerfile.api` final `CMD ["sh","-c","npx prisma migrate deploy … && node apps/api/dist/index.js"]` vs `railway.json:8-9` `preDeployCommand` (migrate) + `startCommand` plain `node …`.
**Gap:** On Railway, `railway.json.startCommand` overrides the Dockerfile CMD, so the correct `preDeploy` path wins and the CMD's migrate is a no-op there. But anyone running the image via `docker run` / `docker-compose` gets migrations executed inside the serving container — and if scaled to >1 replica, concurrent `migrate deploy` calls race on `_prisma_migrations`. Not currently triggered (single Railway replica) but a latent trap.
**Fix:** Make the Dockerfile CMD plain `node apps/api/dist/index.js` (matching `railway.json`) and rely on `preDeployCommand` / an explicit one-off migration step for non-Railway runs.

### L2 — No queue-depth alert on the in-process email/SMS/abandoned-cart queues

**Verdict:** PLAUSIBLE
**Where:** `apps/api/src/index.ts:373` exposes `emailQueue.getStats()` in the deep `/api/v1/health` payload, and Inngest function failure → P1 (`alerts-failure-watch`). But nothing alerts on _depth/backlog_ of the in-process `emailQueue`/`smsQueue`/`abandonedCartService` queues.
**Gap:** DEPLOYMENT.md's own alert-SLA table lists "queue depth" implicitly under health, but there's no threshold alert — a stuck email/SMS queue only surfaces if someone reads the authenticated health endpoint. Job _failures_ are covered (Inngest→P1); sustained _backlog_ is not.
**Fix:** Add a threshold check (e.g. depth > N for M minutes) in the existing deep-health path that fires `sendAlert({level:'p1', …})`, reusing the throttle.

### L3 — Preview-env isolation gate covers Vercel web+admin only; no equivalent for CF Workers or the Orders app

**Verdict:** PLAUSIBLE
**Where:** `preview-env-isolation.yml` checks `VERCEL_PROJECT_ID_WEB` + `VERCEL_PROJECT_ID_ADMIN` NEXT_PUBLIC_API_URL prod≠preview. `cf-deploy.yml` deploys straight to production on push to main with **no preview environment** at all; Orders isn't in the isolation check.
**Gap:** As deploys migrate to Cloudflare Workers, rule-13 preview isolation has no coverage there (there are no CF preview deploys, so arguably N/A today) and the Orders storefront is unchecked. Bounded because CF path has no preview stage yet, but the gate will silently cover less as the cutover proceeds.
**Fix:** When CF preview Workers land (`docs/migration/cloudflare-preview-workers.md`), extend an isolation check to them; add Orders to any preview-env matrix if it gains preview deploys.

### L4 — `.env.example` completeness not machine-verified this pass

**Verdict:** PLAUSIBLE
**Where:** `.env.example` (root) + `apps/api/.env.example` both present. A `process.env.*`-vs-example diff was attempted but the shell command errored before producing output; not confirmed complete.
**Gap:** Cannot assert env-example parity with actually-referenced vars (e.g. `ALERTS_WEBHOOK_TOKEN`, `INNGEST_SERVE_HOST`, `AXIOM_TOKEN`, `ALLOW_BYPASSRLS_ROLE`, `SENTRY_AUTH_TOKEN` if H2 is fixed). These are documented in DEPLOYMENT.md but may be missing from `.env.example`.
**Fix:** Run `grep -oE 'process\.env\.[A-Z_0-9]+' -r apps/api/src | sort -u` against `apps/api/.env.example` and add any missing keys with placeholder values + comments.

---

## What's CONFIRMED-GOOD (verified, no action)

- **Migration-before-deploy on the real path:** `railway.json:8` `preDeployCommand: prisma migrate deploy` + plain `node` `startCommand` — correct, and `docs/ROLLBACK.md` documents the exec-form trap that this fixes. CI integration/E2E run `prisma migrate deploy` against ephemeral Postgres service containers (never a Neon branch) — `ci.yml:264-268, 399-403`. ✅
- **CI is standard-compliant:** `ci.yml` has top-level `concurrency` w/ `cancel-in-progress` (L35-37), `timeout-minutes` on every job, Prisma `db:generate` BEFORE typecheck (L120 vs L126), audit split prod-zero-tolerance vs dev-high (L454-461), `notify-failure` Telegram job gated on `failure() && push && main` (L484-548), dynamic service ports to avoid collisions. ✅
- **Runner routing:** default self-hosted with `force_cloud` override + `notify-failure` deliberately pinned to `ubuntu-latest` (fail-open when the runner itself dies). Not silently running on Ahmad's PC unconditionally. ✅
- **Alerting P0 coverage:** `uncaughtException`→P0, payment HMAC repeated fail→P0, deep-health degraded→P1 (`index.ts:384-393`), Inngest failure→P1, Railway DEPLOY_FAILED→P0 (`alert-webhooks.routes.ts:108-160`). Telegram throttled + graceful no-op. ✅
- **Boot-time guards:** `ALERTS_WEBHOOK_TOKEN` unset-in-prod → `logger.error` (rule 12, `alert-webhooks.routes.ts:14-19`); `INNGEST_SERVE_HOST` unset-in-prod warning (`index.ts:511-517`); short-JWT warning (`index.ts:495-504`); BYPASSRLS role guard with `ALLOW_BYPASSRLS_ROLE` escape hatch (`index.ts:443-480`). ✅
- **Log retention:** Axiom `@axiomhq/pino`, 30-day, dataset `force-api-railway`, redaction applied, graceful no-op — documented in `DEPLOYMENT.md:395-417` + `docs/RETENTION.md`. Satisfies rule 11. ✅
- **DR / backups:** dual-layer — local `pg_dump` (launchd daily, `scripts/backup-db.sh`) + off-machine encrypted R2 daily (`db-backup.yml`, PG17 via docker, size-guard, Telegram-on-failure, 30-day prune). `neon-snapshot.yml` correctly retired to `workflow_dispatch`-only. ✅
- **Rollback:** `scripts/rollback.sh` refuses on uncommitted changes, warns on migration-bearing HEAD, git-revert+push; `docs/ROLLBACK.md` has all three paths + the exec-form migration trap. ✅
- **Preview isolation (Vercel):** `preview-env-isolation.yml` CI-enforces prod≠preview `NEXT_PUBLIC_API_URL` weekly + per-PR, with fork-PR guard. ✅
- **Client Sentry + tenant context surface:** web/admin client init via `instrumentation-client.ts` (the correct post-v9 hook), API `sentry.service.ts` with Express error handler wired last (`index.ts:425`). ✅

---

## Ranked findings table

| #   | Sev  | Verdict             | Finding                                                                                                | Where                                                                         |
| --- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| H1  | High | CONFIRMED           | Orders PWA deployed with zero Sentry (client + server)                                                 | `apps/orders/` (no sentry dep/instrumentation); `cf-deploy.yml` deploy-orders |
| H2  | High | CONFIRMED           | Sentry source maps never uploaded (no `withSentryConfig`) → minified prod traces                       | `apps/web/next.config.js:165`; `apps/admin/next.config.js:152`                |
| H3  | High | CONFIRMED           | 242 branches incl. orphan `auto-fix/*` — hygiene + gitleaks surface                                    | `git branch -a`                                                               |
| M1  | Med  | CONFIRMED           | `deploy.yml`: no timeouts, no concurrency, migrate-after-deploy, no DIRECT_URL                         | `deploy.yml:121-142`                                                          |
| M2  | Med  | CONFIRMED           | DEPLOYMENT.md stale: "Vercel Hobby" only, omits live CF Workers auto-deploy                            | `DEPLOYMENT.md:26,321-328` vs `cf-deploy.yml`                                 |
| M3  | Med  | CONFIRMED           | Server-side Sentry inactive on Cloudflare Workers target (SSR/RSC dark)                                | `apps/web/instrumentation.ts` header; `scripts/cf-build.sh`                   |
| M4  | Med  | CONFIRMED           | Missing timeout-minutes/concurrency on gitleaks, zap, lighthouse, load-test, cloud-rescue, preview-env | `.github/workflows/*`                                                         |
| M5  | Med  | CONFIRMED/PLAUSIBLE | gitleaks installs via `sudo tar` but defaults to no-sudo self-hosted runner                            | `gitleaks.yml:20,31`                                                          |
| M6  | Med  | PLAUSIBLE           | gitleaks scans pushed ref only, not all 242 branches                                                   | `gitleaks.yml:34-35`                                                          |
| L1  | Low  | PLAUSIBLE           | Dockerfile.api CMD also migrates → double-migrate/multi-replica race off-Railway                       | `Dockerfile.api` CMD vs `railway.json:8-9`                                    |
| L2  | Low  | PLAUSIBLE           | No queue-depth/backlog alert on in-process email/SMS/cart queues                                       | `apps/api/src/index.ts:373`                                                   |
| L3  | Low  | PLAUSIBLE           | Preview-isolation gate covers Vercel web/admin only; not CF Workers/Orders                             | `preview-env-isolation.yml`                                                   |
| L4  | Low  | PLAUSIBLE           | `.env.example` parity not machine-verified this pass                                                   | `.env.example`, `apps/api/.env.example`                                       |

**Counts:** Critical 0 · High 3 · Medium 6 · Low 4 — total 13.
