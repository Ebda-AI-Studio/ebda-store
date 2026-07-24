# Answer-Engine Insights — Plan 8B: Force-Managed GSC Ingestion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ingest Google Search Console Search Analytics (impressions/clicks/CTR/position + top queries) per merchant domain via ONE Force-managed credential, store daily aggregates, and surface them in the answer-engine dashboard — the second (official first-party) signal alongside Plan 8A's citation checking.

**Architecture:** A daily Inngest cron enumerates stores that have a `domain` + the `answer_engine_insights` feature + AI-eligible plan, resolves each to a GSC property, calls the GSC Search Analytics API with a single Force-managed service-account credential, and writes append-only `GscDailyMetric` rows. A dashboard section (added to Plan 8A's `stores/[id]/answer-engine` page) trends them. **Dormant until credentialed:** with no `GSC_SERVICE_ACCOUNT_JSON` env set, the cron logs "GSC not configured" and no-ops — exactly like Plan 8A's paid engines are dormant until keyed.

**Tech Stack:** Express + TS (`apps/api`), Google service-account auth (`google-auth-library` JWT → token, or mint the assertion with the existing `jsonwebtoken` dep — implementer picks the leaner), GSC Search Analytics REST (`webmasters/v3`), Inngest cron, Prisma + Neon, Next.js admin, Vitest.

**Depends on:** Plan 8A (this branch is stacked on `feat/answer-engine-insights`) — reuses the `answer_engine_insights` feature key, the `stores/[id]/answer-engine` dashboard, and the answer-engine read-route module.
**Source of truth:** spec `docs/superpowers/specs/2026-07-22-answer-engine-insights-design.md` §3b.

## Global Constraints

- **Force-managed, single platform credential** — a Google **service account** (JSON key in env `GSC_SERVICE_ACCOUNT_JSON`, a platform secret) added as a user on the Force-owned GSC properties. NOT per-merchant OAuth. Store↔property mapping is by `Store.domain` (normalize: lowercase, strip leading `www.`), tried as both `sc-domain:<domain>` and `https://<domain>/` forms.
- **Dormant until credentialed** — no `GSC_SERVICE_ACCOUNT_JSON` → the cron no-ops (logged), no crash. A store with no `domain`, or whose property returns 403/not-found, is SKIPPED + recorded, never aborts the run (fail-soft).
- **Aggregate-not-event model** — `GscDailyMetric` is one row per (storeId, date) (mirror `ProductDailyView`), `@@unique([storeId, date])`, upsert on re-run (idempotent). NOT a row per impression.
- **Tenant isolation** — every metric row is `storeId`-scoped + RLS (mirror `answer_engine_checks`); the dashboard returns only the viewer's store.
- **Credential/secret never logged**; the service-account private key stays in env, never in a response or log line.
- **Migrations hand-authored** — `migrate deploy` on a throwaway scratch DB; NEVER `migrate dev`; `@@map` snake_case; timestamp after the newest existing migration.
- **Zero-dep charts**; bilingual EN+AR; store-scoped; no `store.slug` branching.
- **New dep discipline** — if `google-auth-library` is added: registry-real, pinned exact, `npm audit` 0 new high/critical. Prefer reusing the existing `jsonwebtoken` dep to mint the service-account JWT if that's clean.
- **commitlint** lowercase subject; blank line before `Co-Authored-By`; `git add` specific paths only; do NOT dirty package-lock.json unless a dep is genuinely added.
- **PREFLIGHT before push:** `.superpowers/` is already in `.prettierignore` on this stacked branch (inherited from 8A) — confirm; prettier-format the committed plan md.

---

## File Structure

**Create:**

- `apps/api/src/services/answer-engine/gsc-client.ts` — service-account auth + `querySearchAnalytics(siteUrl, from, to)`; returns typed rows or null when uncredentialed.
- `apps/api/src/services/answer-engine/gsc-ingest.service.ts` — `runGscIngest(storeId, opts?)` (client injectable): resolve property, query, upsert `GscDailyMetric`.
- `apps/api/src/lib/inngest/functions/gsc-ingest.ts` — daily cron + on-demand twin.
- `packages/database/prisma/migrations/<ts>_gsc_daily_metric/migration.sql`.
- Tests: `apps/api/src/services/answer-engine/__tests__/gsc-*.test.ts` (unit, mocked HTTP) + `tests/integration/answer-engine/gsc-ingest.test.ts`.

**Modify:**

- `packages/database/prisma/schema.prisma` — `GscDailyMetric` model + `Store` back-relation.
- `apps/api/src/lib/inngest/functions/index.ts` + `client.ts` — register cron + `gsc/ingest-requested` event.
- `apps/api/src/routes/answer-engine.routes.ts` (from 8A) — add a `GET .../answer-engine/gsc` (or extend summary) read endpoint.
- `apps/admin/src/app/stores/[id]/answer-engine/page.tsx` (+ `_components/*`) — a GSC metrics section.
- `docs/ENVIRONMENT.md` (`GSC_SERVICE_ACCOUNT_JSON`), `docs/business/plan-feature-matrix.md` (note GSC under the same feature).

---

## Task 1: `GscDailyMetric` model + migration

**Files:** `packages/database/prisma/schema.prisma`, new migration dir.

- [ ] **Step 1: Edit schema** — mirror `ProductDailyView` (aggregate, `@@map`, `@@unique`, RLS-target on `store_id`, `onDelete: Cascade`):

```prisma
model GscDailyMetric {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  date        DateTime @db.Date
  impressions Int      @default(0)
  clicks      Int      @default(0)
  ctr         Float    @default(0)
  position    Float    @default(0) @map("avg_position")
  topQueries  Json     @default("[]") @map("top_queries")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)
  @@unique([storeId, date])
  @@index([storeId, date(sort: Desc)])
  @@map("gsc_daily_metrics")
}
```

Add `gscDailyMetrics GscDailyMetric[]` to `model Store`.

- [ ] **Step 2: Hand-author migration** `<ts>_gsc_daily_metric/migration.sql` — `CREATE TABLE "gsc_daily_metrics"` with mapped column names + unique + index + FK to `stores` ON DELETE CASCADE; **add RLS** (enable + tenant policy mirroring `answer_engine_checks`, since it has `store_id`). Physical `@@map` names, not model names.
- [ ] **Step 3:** Verify on a THROWAWAY docker Postgres (`migrate deploy` full chain; NEVER real DB) → table + unique + RLS present.
- [ ] **Step 4:** `npm run db:generate`.
- [ ] **Step 5: Commit** — `feat(database): add gsc_daily_metrics table`

---

## Task 2: GSC client (service-account auth + Search Analytics) — dormant until credentialed

**Files:** `gsc-client.ts`, `__tests__/gsc-client.test.ts`.

**Interfaces:** Produces `isGscConfigured(): boolean` (env present) + `querySearchAnalytics(siteUrl, from, to): Promise<GscRow[]>` where `GscRow = { date?, impressions, clicks, ctr, position, query? }`; and a property-resolution helper `gscSiteUrlsForDomain(domain): string[]` (`['sc-domain:<d>', 'https://<d>/']`).

- [ ] **Step 1: Failing tests** — mock global `fetch` (and the token mint): `isGscConfigured()` false with no env, true with a valid `GSC_SERVICE_ACCOUNT_JSON`; `querySearchAnalytics` maps a canned GSC `rows[]` response → `GscRow[]`; a 403 (no access to property) → returns `[]` / throws a typed `GSC_NO_ACCESS` the caller treats as skip (decide + test); malformed response → safe empty, no throw. Auth: assert the request carries a Bearer token minted from the service account (mock the token step).
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — parse `GSC_SERVICE_ACCOUNT_JSON` (client_email + private_key); mint a Google OAuth2 access token (scope `https://www.googleapis.com/auth/webmasters.readonly`) via `google-auth-library` JWT client OR a hand-minted RS256 assertion with the existing `jsonwebtoken` dep → POST to `https://oauth2.googleapis.com/token`; then POST to `https://www.googleapis.com/webmasters/v3/sites/<encoded siteUrl>/searchAnalytics/query` with `{ startDate, endDate, dimensions:['date'] }` (+ a second call `dimensions:['query']` for top queries, capped). Defensive parse. Never log the key. If a new dep is added, pin + audit.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(api): gsc search-analytics client (service-account, dormant until credentialed)`

---

## Task 3: GSC ingestion cron (fail-soft, tenant-scoped)

**Files:** `gsc-ingest.service.ts`, `gsc-ingest.ts`, `functions/index.ts`, `client.ts`, tests.

**Interfaces:** Produces `runGscIngest(storeId, opts?: { client?, date? })` + `gscIngestCron` (daily) + `gscIngestOnDemand` (event `gsc/ingest-requested`, `{storeId}`).

- [ ] **Step 1: Failing integration test** — seed an entitled store with a `domain`; inject a MOCK gsc client returning canned rows; invoke on-demand ingest → a `GscDailyMetric` row is upserted for that store/date with the mapped totals + topQueries; re-running upserts (no dup, `@@unique`). A store with NO domain → skipped, zero rows. A `client` reporting no-access → skipped + recorded, no throw. A NON-entitled / free-plan store → skipped. With `isGscConfigured()` false → cron no-ops.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — `runGscIngest`: load store `{domain}`; if none → skip; resolve siteUrl (try the `gscSiteUrlsForDomain` forms), query yesterday, upsert `GscDailyMetric` (`upsert` on `storeId_date`). The cron (mirror `stock-reorder-scan.ts`): if `!isGscConfigured()` → log + return; else enumerate `{ deletedAt:null, status:'active', domain: { not: null }, aiFeaturesEnabled:true, ...aiEligiblePlanFilter }` with per-store `isFeatureEnabled('answer_engine_insights')` gate, batch, per-store `step.run` wrapped in try/catch (fail-soft — one store's failure never aborts the run) + `runInTenantContext`. Register cron + on-demand in `functions/index.ts` + the event in `client.ts` `AppEvent` union; note the `INNGEST_DEPLOY_ID` trap.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(api): daily gsc ingestion cron (force-managed, fail-soft)`

---

## Task 4: Dashboard GSC section + docs + blast-radius

**Files:** `answer-engine.routes.ts` (extend), `apps/admin/.../answer-engine/page.tsx` (+ `_components`), `docs/*`, tests.

- [ ] **Step 1: Failing integration test** — seed `GscDailyMetric` rows for store A; `GET .../answer-engine/gsc` (or the extended summary) returns A's impressions/clicks/CTR/position trend + top queries; **tenant-isolation: store B's rows never returned to store A**; feature-off → 404/empty; a store with no GSC data → an empty/"not connected" state (not an error).
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — the read endpoint (same auth chain + cache≥120s as the 8A summary route; store-scoped query on `GscDailyMetric`); a GSC section on the 8A dashboard page (zero-dep trend chart mirroring the 8A `TrendChart`, a top-queries list, and a clear "GSC not connected" empty state), bilingual, feature-gated.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Docs + blast-radius** — `docs/ENVIRONMENT.md` (`GSC_SERVICE_ACCOUNT_JSON` + note it's a Force-managed platform secret, feature dormant until set); `docs/business/plan-feature-matrix.md` (note GSC is part of `answer_engine_insights`); blast-radius sweep (`GscDailyMetric` readers/writers + UI, the cron registration, `GSC_SERVICE_ACCOUNT_JSON`, the new route) → state the result.
- [ ] **Step 6: Commit** — `feat: gsc metrics dashboard section + docs`

---

## Final verification (before PR)

- [ ] typecheck + lint clean; gsc unit + integration suites green; `npm audit` 0 new high/critical (if a dep added).
- [ ] Whole-branch review (Opus): dormant-until-credentialed correctness, secret (service-account key) non-leak, tenant isolation on metrics + dashboard, fail-soft ingestion, idempotent upsert.
- [ ] Prettier preflight (confirm `.superpowers/` ignored; format this plan md).
- [ ] Blast-radius statement in the PR body. **PR → base `feat/answer-engine-insights` (STACKED on 8A), NOT merged.** When 8A merges to main, retarget → main.

## ⚠️ Go-live gate (Ahmad, before real data flows)

GSC ingestion is DORMANT until: (1) a Force Google service account is created, (2) its `client_email` is added as a user on the Force-owned GSC properties covering merchant domains, (3) `GSC_SERVICE_ACCOUNT_JSON` is set in the API env. Until then the cron no-ops. Live-smoke one real property before relying on the data.
