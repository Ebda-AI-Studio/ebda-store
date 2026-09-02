## 3. Infrastructure & DevOps Audit

### Executive summary

FWB's infra is a well-structured three-platform deploy (Vercel × 2 + Railway × 1 + Neon + R2 + Redis) with strong observability, correct rollback automation, and good CI coverage. The stack has been hardened over multiple audit rounds: exec-form trap is fixed in the _root_ `railway.json`, log drain is Axiom (30-day verified), uptime monitoring is live on UptimeRobot, and the rule-13 preview isolation check is an automated workflow. The residual risks cluster around two spots: a **divergent second `railway.json`** that still uses the broken shell-chain pattern, and a **stale `DEPLOYMENT.md`** that documents Cloudflare Pages + Supabase instead of the live Vercel + Neon topology. Two ⚠️ operational gaps also need attention before Merchant #2 onboards.

---

### Deployment topology

```
Browser (storefront visitor)
        │
        ▼
┌────────────────────────────────┐
│  Vercel force-web              │
│  store.forcemediakw.com (default)
│  wadyaljuz.com (per-tenant)    │
│  (Next.js 16 App Router)       │
└────────────┬───────────────────┘
             │  HTTPS + credentials:include (cross-origin cookie)
             ▼
┌────────────────────────────────────────────────┐
│  Railway API  — store-api.forcemediakw.com     │
│  (Express.js, Dockerfile.api, Railpack runner) │
│  + Redis (railway internal :6379)              │
└────┬──────────┬──────────────┬─────────────────┘
     │          │              │
     ▼          ▼              ▼
  Neon      R2 (r2.dev)    Inngest cloud
  Postgres

Browser (admin)
        │
        ▼
┌────────────────────────────────┐
│  Vercel force-admin            │
│  app.forcemediakw.com          │
│  (Next.js 16, standalone mode) │
└────────────────────────────────┘
```

Six deploy surfaces: Vercel force-admin, Vercel force-web, Railway API, Neon, Cloudflare R2, Railway Redis. All auto-deploy from `main` on push (Railway) or on Vercel commit (Vercel). No true staging API service; preview builds intentionally point to `http://localhost:4000` (non-functional by design — rule 13 posture documented).

> _(2026-07-10 correction — point-in-time audit snapshot, left otherwise as-is: the "Railpack runner" label on the Railway API box above was never accurate. `railway.json` sets `builder: DOCKERFILE` / `dockerfilePath: Dockerfile.api`, and that's what Railway actually builds. Confirm the live Railway service's builder in the dashboard if deploy behaviour is ever in question. Separately, this whole diagram predates the Cloudflare Workers migration — `force-web`/`force-admin` are Vercel here but are now Cloudflare Workers; see `CLAUDE.md` for current topology.)_

---

### Findings

#### 3.1 Vercel admin (force-admin)

**✅ P2 — mostly correct.**

- Next.js 16 + App Router. `output: 'standalone'` set (`apps/admin/next.config.js:11`) — Vercel-specific build artefact.
- Security headers wired via headers block (HSTS, nosniff, CSP, Referrer-Policy, Permissions-Policy). X-Frame-Options intentionally removed 2026-05-20 in favour of `frame-ancestors`-only CSP.
- `NEXT_PUBLIC_SENTRY_DSN_ADMIN` expected on Vercel; gracefully no-ops when missing.
- Auth handled client-side (AuthProvider) — `middleware.ts` intentionally passthrough. Cross-origin cookie flow with `SameSite=None; Secure` documented.

**⚠️ P2 — DEPLOYMENT.md documents Cloudflare Pages, not Vercel.** Root `DEPLOYMENT.md` lines 7-33 describe Cloudflare Pages + Supabase as the frontend/DB stack. Actual prod is Vercel + Neon. New contributor or incident responder following this doc will provision the wrong infra. Observability section (line 386+) is accurate.

**⚠️ P3 — Stale Vercel project references in `docs/ROLLBACK.md`.** Path A URLs reference `force-admin-seven` and `force-web-sigma` — stale projects per CLAUDE.md.

#### 3.2 Vercel web (force-web)

**✅ P2 — good.**

- Multi-tenant domain resolution via middleware (store resolved from host header).
- ISR (`revalidate`) used in `sitemap.ts`, `manifest.ts`, `llms.txt/route.ts`.
- CSP headers include both old Railway URL and new custom domain in `connect-src`. Both needed during migration window but old one is dead weight once traffic fully moves.
- `STOREFRONT_FRAME_ANCESTORS` env var configures CSP `frame-ancestors` without code push.

**⚠️ P3 — `remotePatterns` includes stale `*.supabase.co`** (`apps/web/next.config.js:41-44`). Neon replaced Supabase but pattern remains. No security risk (whitelist), but misleading.

**⚠️ P3 — Vercel Hobby 4.5 MB body cap risk.** API is on Railway (no Vercel cap), but storefront's Next.js Route Handlers for any future webhook or upload path would hit the limit. Not currently triggered (uploads go to R2 presigned URLs through API).

#### 3.3 Railway API

**⚠️ P0 — `railway.json` exec-form trap STILL EXISTS in `apps/api/railway.json`.**

Two `railway.json` files present:

- `/railway.json` (root): correctly uses `preDeployCommand` + bare `startCommand: "node apps/api/dist/index.js"` — fix from commit `decd870`.
- `/apps/api/railway.json`: **still uses broken shell-chain pattern**: `"startCommand": "cd apps/api && npx prisma migrate deploy ... && node dist/index.js"`.

Railway deploys from repo root so picks up `/railway.json` first. But if Railway ever resolves to service-level `railway.json` (after config change or service re-link), old exec-form reverts silently. Three documented consecutive silent failures from this exact pattern (`1066ea5`, `44b6462`) are in memory. **Fix:** delete `apps/api/railway.json` or sync to root.

**⚠️ P1 — Railway build failure invisibility partially unmitigated.** CI `npm run build` (ci.yml:91) catches TypeScript errors before Railway sees them — correct mitigation. But Railway-side notifications NOT documented as configured. If CI bypassed (direct push without PR), Railway-side build failure goes unnoticed until route probe.

**✅ Health check configured.** `railway.json:healthcheckPath = "/health"`, 120s timeout, ON_FAILURE restart, 3 retries.

**✅ Inngest deploy sync fixed.** `apps/api/src/lib/inngest/client.ts:174-181` auto-maps `RAILWAY_DEPLOYMENT_ID` → `INNGEST_DEPLOY_ID` at boot.

**✅ Migration apply wired correctly in root `railway.json`.** `preDeployCommand` runs migrations before new replica promoted.

**✅ trust proxy set correctly.** `app.set('trust proxy', 1)` — IP-keyed rate limiters work behind Railway proxy.

**✅ Non-root user.** `Dockerfile.api` creates system user `api` (uid 1001).

#### 3.4 Neon database

**✅ P1 — Snapshot workflow present and correct.** `.github/workflows/neon-snapshot.yml` fires on every push to `main`, creates `prod-<8-char-sha>` branch, prunes oldest beyond 9. Prune logic uses `sort_by(.created_at) | reverse | .[9:]`.

**⚠️ P2 — Neon branch hygiene not enforced.** CLAUDE.md documents "never create branches casually — free tier caps at 10." No automated check verifies branch count. If ad-hoc Neon branches are created manually, snapshot workflow could silently start failing when hits cap.

**✅ RLS via AsyncLocalStorage documented.** `runInTenantContext` pattern + "re-verify after snapshot restore" requirement in `docs/ROLLBACK.md:75`.

**⚠️ P2 — `sslmode` not verified in DATABASE_URL.** `feedback-pg-sslmode-verify-full.md` warns pg v9 demotes `sslmode=require`. Config (`config/index.ts:48`) reads `DATABASE_URL` verbatim with no validation. Whether `?sslmode=verify-full` is set in Railway env invisible from code.

#### 3.5 Cloudflare R2 storage

**✅ Configuration correct.** S3-compatible API, public bucket via `*.r2.dev`, `STORAGE_*` env vars on Railway.

**⚠️ P3 — R2 egress pricing.** R2 has no egress fee for reads from `*.r2.dev` (Cloudflare waives egress for R2). Competitive vs S3. However, `DEPLOYMENT.md` CORS config shows placeholder domains — per-store custom domain origins not maintained in CORS allowlist. May cause upload failures.

**⚠️ P3 — Stale `*.supabase.co` in `next.config.js`** (same as 3.2).

#### 3.6 Redis cache

**✅ Railway internal URL.** `redis.railway.internal:6379` — not exposed publicly. No auth on internal Railway network (acceptable threat model).

**✅ TTL floor enforced.** ESLint rule blocking sub-120s TTLs (commit `b6e6cd7`).

**⚠️ P2 — No Redis persistence documented.** Railway Redis ephemeral by default. On service restart Redis cache wiped. Acceptable for cache, but `alerts.service.ts` throttle key (Redis-keyed, 5-min TTL) also wiped — flapping alert that was throttled could re-flood Telegram after restart.

#### 3.7 CI/CD pipeline

**✅ Pipeline comprehensive.** `.github/workflows/ci.yml` gates: lint → format check → typecheck → build → unit tests (vitest+coverage) → integration tests (postgres:16 + redis:7 services) → e2e tests → `npm audit --audit-level=low` → trufflehog. Gitleaks runs separately.

**✅ `audit-level=low` in CI.** Line 339: `npm audit --audit-level=low`. Matches zero-vulns policy. Root `package.json:60` script `audit:high` uses `--audit-level=high` — discrepancy is only in dev convenience script; CI uses correct gate.

**⚠️ P1 — Integration and E2E tests marked `continue-on-error: true`** (ci.yml lines 134, 252). Test failures don't block pipeline. Failing integration test lets CI go green, commit lands, Railway deploys broken code. `continue-on-error` likely added to avoid blocking on flakiness, but correct fix is flake-mitigation + removing the flag.

**✅ Preview isolation check.** `.github/workflows/preview-env-isolation.yml` runs on PR + weekly schedule. Reads Vercel env vars via API, fails if Preview `NEXT_PUBLIC_API_URL` matches Production. Requires `VERCEL_API_TOKEN` + `VERCEL_PROJECT_ID_*` secrets — if not configured, warns and exits 0 (opt-in not enforced).

> **Correction (2026-09-02, PR #1133):** `preview-env-isolation.yml` was deleted. It checked
> **Vercel** project env vars via the Vercel API; FWB's Vercel projects were decommissioned in the
> 2026-07 Cloudflare migration, so `VERCEL_API_TOKEN`/`VERCEL_PROJECT_ID_*` were absent from repo
> secrets and every run fell through its own "unset → warn + exit 0" branch — reporting `success`
> on every PR while checking nothing. See `docs/DEPLOYMENT.md`'s "Environments & staging posture"
> section for the current (real) mitigation and gap: no automated CI check currently verifies the
> safe-by-default preview `NEXT_PUBLIC_API_URL=http://localhost:4000` hasn't been overridden to
> point at production.

**⚠️ P2 — `deploy.yml` is dead workflow.** Builds Docker images to GHCR, references `staging`/`production` environments. Never used (no tag-triggered runs ever ran). Confusing.

**⚠️ P2 — No Railway deploy notification in CI.** CI passes → Vercel auto-deploys from commit. But Railway auto-deploys from `main` independently. If pushed directly to `main` bypassing PR (Ahmad does regularly), CI runs in parallel with Railway build. Railway may finish deploying before CI finishes typecheck, meaning broken build hits prod before CI flags it.

#### 3.8 Backup + rollback discipline

**✅ All four pieces present and correct.**

1. **`.github/workflows/neon-snapshot.yml`** — verified.
2. **`scripts/rollback.sh`** — blocks on uncommitted changes, warns on migration-bearing HEAD, git-revert + push.
3. **`scripts/backup-db.sh`** — resolves `DATABASE_URL` from env > `apps/api/.env` > `.env`, pg_dump + gzip to `~/Desktop/projects/_backups/force-website-builder/`, keeps 30.
4. **`docs/ROLLBACK.md`** — documents all 3 paths. Migration auto-apply check thorough. RLS re-verification documented.

**⚠️ P2 — `docs/ROLLBACK.md` uses stale Vercel project slugs** (lines 11, 17 reference `force-admin-seven` and `force-web-sigma`). Rollback path A will fail under incident pressure.

#### 3.9 Monitoring + alerting

**✅ Five-channel observability stack is excellent.**

1. **UptimeRobot** — three monitors (API health, wadyaljuz, admin), 5-min interval, public status page. Per-merchant monitor instructions documented.
2. **Sentry** — three projects (api/web/admin), correct `tracesSampleRate` (0.1 prod / 1.0 admin), no-op when DSN missing. _(updated 2026-07-02: now four — PR #497 adds `orders`; this is a point-in-time audit snapshot, left otherwise as-is.)_
3. **PostHog** — consent-gated on storefront (rule 5 compliant), always-on on admin.
4. **Telegram alerts** — `@ForceAI1_bot`, Redis-throttled (300s TTL), scope-aware headers, graceful no-op when unconfigured. P0/P1/info severity levels.
5. **Axiom log drain** — `@axiomhq/pino` transport, in-process (no Railway Pro dependency), 30-day retention verified, dataset `force-api-railway`.

**✅ `ALERTS_WEBHOOK_TOKEN` boot warning implemented.** `alert-webhooks.routes.ts:14-18` logs `logger.error(...)` at boot when prod token unset.

**⚠️ P2 — UptimeRobot monitor count stale.** DEPLOYMENT.md says "2 monitors currently" but lists 3.

**⚠️ P1 — No Railway build failure notification.** Application-level P0s covered by Telegram, but no hook from Railway's build pipeline. TypeScript error in multi-file commit keeps old container serving with no notification.

#### 3.10 Env var management

**✅ Fail-fast for critical prod vars.** `apps/api/src/config/index.ts:8-16`: `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` throw at boot in production when unset. `JWT_SECRET` auto-generates in dev only.

**✅ Required vs optional split documented** in CLAUDE.md lines 302-335.

**⚠️ P1 — `DIRECT_URL` not in fail-fast guard.** Required for Prisma migrate but not in `getRequiredSecret` list. If `DIRECT_URL` missing on Railway, `preDeployCommand` (`prisma migrate deploy`) fails silently — either skipping migration or using pooled `DATABASE_URL` which doesn't support DDL on Neon serverless.

**⚠️ P2 — No `.env.example` existence verified.** No automated check that `.env.example` stays in sync with required vars. DEPLOYMENT.md env var table lists Supabase-era vars.

#### 3.11 Multi-tenant domain provisioning

**✅ `VercelDomainService` fully implemented.** `apps/api/src/services/vercel-domain.service.ts` calls Vercel REST API to add custom domain, auto-attaches `www` variant for apex domains (GoDaddy locked CNAME workaround), verifies TXT/CNAME challenges, returns DNS instructions for merchant. Configured via `VERCEL_API_TOKEN` + `VERCEL_PROJECT_ID` + optional `VERCEL_TEAM_ID`.

**✅ Graceful no-op when unconfigured.** `VercelDomainService.isConfigured()` checks for token + project ID before API call.

**⚠️ P2 — Wildcard SSL coverage gap.** Vercel Hobby supports custom domains but not wildcard SSL (`*.merchant.com`) per-tenant. Each tenant's `custom-domain.com` gets own SSL cert (Let's Encrypt). Service auto-adds `www`; other subdomains need manual add-domain calls.

**⚠️ P3 — `VERCEL_TEAM_ID` optional but Hobby is not a team.** On Ahmad's Hobby account no `teamId`. `getTeamQuery()` returns empty string when unset (correct). But if moved to Pro Team, forgetting to set `VERCEL_TEAM_ID` will 403 all domain operations.

#### 3.12 Vendor lock-in surface

| Vendor                | Lock-in                                                                                                                                                                                                                                                                    | Migration cost | Notes                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel**            | ISR revalidate, `next/image` optimization, `outputFileTracingRoot`, standalone output, App Router server components                                                                                                                                                        | Medium         | Any Node-capable CDN host (Netlify, CF Pages) would work if drop ISR for on-demand cache invalidation. Vercel Domain API in `vercel-domain.service.ts` is hardest tie — needs replacement |
| **Railway**           | Dockerfile detection (`Dockerfile.api`), `RAILWAY_DEPLOYMENT_ID` env var, Railway internal Redis URL _(2026-07-10 correction: was listed as "Railpack/Dockerfile detection" — `railway.json` pins `builder: DOCKERFILE`, confirm live dashboard setting if ever in doubt)_ | Low            | Standard Dockerfile builds; Railway-specific code is only one env var fallback. Easy to containerize to Fly.io/Render                                                                     |
| **Neon**              | `preDeployCommand` pattern, branching workflow, `neondb_owner` vs `force_app` roles, pooler vs direct URL split                                                                                                                                                            | Medium         | Postgres-compatible but snapshot branching workflow is Neon-specific                                                                                                                      |
| **Cloudflare R2**     | S3-compatible API (AWS SDK compatible), `*.r2.dev` public URL                                                                                                                                                                                                              | Low            | Drop-in swap for any S3-compatible store                                                                                                                                                  |
| **Inngest**           | `inngest` SDK, function signatures, event naming, `INNGEST_*` env vars                                                                                                                                                                                                     | Medium         | No open-source self-host; migration = rewrite all background jobs to BullMQ or similar                                                                                                    |
| **Gemini Flash Lite** | `gemini-flash-lite-latest` model name, daily/monthly cap logic                                                                                                                                                                                                             | Low            | Swap `GEMINI_MODEL` env var + update `ai-quota.ts` daily caps                                                                                                                             |
| **OneSignal**         | `react-onesignal` SDK on admin, script-tag init on storefront                                                                                                                                                                                                              | Medium         | Migration to web-push-only would drop ~5 admin files + storefront init; VAPID path exists                                                                                                 |

**Most expensive migration:** Vercel Domain API (VercelDomainService) — only piece calling proprietary control-plane API. If Vercel changes pricing or deprecates domain API, per-tenant domain provisioning breaks with no fallback. Worth building `DomainProvider` interface abstraction before Merchant #10.

---

### Top 5 P0/P1 infra risks

**Risk 1 — ⚠️ P0: Divergent `apps/api/railway.json` exec-form trap**
File `apps/api/railway.json` still has `startCommand` with `&&` chain. Root `/railway.json` has correct `preDeployCommand` split. If Railway resolves to service-level file, migrations run but API process never starts — exactly the three-silent-deploy failure documented in memory. Delete or update.

**Risk 2 — ⚠️ P1: Integration + E2E tests `continue-on-error: true`**
CI lines 134, 252. Failing integration tests don't block pipeline or deployment. Broken auth flow, payment webhook regression, or multi-tenant isolation regression will silently pass CI and deploy. Remove flag; fix flaky tests with retry logic.

**Risk 3 — ⚠️ P1: `DIRECT_URL` not fail-fast guarded**
Config doesn't validate `DIRECT_URL` as required production secret. Without it, `prisma migrate deploy` in `preDeployCommand` fails silently on Neon serverless (DDL ops require non-pooled direct connection). Railway env var deletion would cause all future deploys to skip migration application with no startup crash.

**Risk 4 — ⚠️ P1: No Railway build failure notification channel**
Railway builds fail silently — old container keeps serving, health checks pass, only new routes 404. CI's build job mitigates for PR workflows but direct pushes to `main` race CI. Neither `DEPLOYMENT.md` nor alert bridge docs show Railway build failure notifications routed to Telegram.

**Risk 5 — ⚠️ P1: `DEPLOYMENT.md` documents wrong infrastructure**
`DEPLOYMENT.md` lines 7-33 diagram Cloudflare Pages + Supabase. Actual topology is Vercel + Neon. During incident, this doc will actively mislead. Additionally `docs/ROLLBACK.md` lines 11/17 reference stale `force-admin-seven` and `force-web-sigma`. Rollback path A will 404.
