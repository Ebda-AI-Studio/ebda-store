# Answer-Engine Insights — Plan 8A: Citation Checking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether AI answer engines cite each merchant's store — via pluggable engine providers (Gemini grounded search ACTIVE/free by default; Perplexity + OpenAI built but DORMANT until an admin keys them in), a weekly per-store cron, and a merchant dashboard.

**Architecture:** An `AnswerEngineProvider` interface with 3 adapters. A weekly Inngest cron enumerates AI-eligible stores, generates buyer-intent prompts, runs each ENABLED provider through the `ai-quota` budget guard, detects whether the store's domain/brand is cited (Gemini uses grounding-metadata source URLs), and writes append-only `AnswerEngineCheck` rows. A super-admin config surface (encrypted keys + per-engine toggle, `PaymentConfig`-style masking) turns the paid engines on with no redeploy. A merchant dashboard (zero-dep charts) shows cited-vs-competitors trends with recs deep-linking to the existing `bulk-ai-geo` sweeps.

**Tech Stack:** Express + TS (`apps/api`), `@google/generative-ai@0.24.1` (Gemini), Perplexity + OpenAI via `fetch`, Inngest cron, Prisma + Neon, Zod (`@ebda/shared`), Next.js admin (`apps/admin`), Vitest.

**Source of truth:** spec `docs/superpowers/specs/2026-07-22-answer-engine-insights-design.md`. Sibling (GSC) ships in Plan 8B.

## Global Constraints

- **Provider API keys are SECRETS:** encrypt on write (`encryption.encrypt`), mask on read (`encryption.mask` → `sk_a****1234` / `****`), never logged; the "unchanged if incoming contains `****`" merge (don't clobber the stored secret). Mirror `apps/api/src/routes/payment-settings.routes.ts` + `apps/api/src/services/encryption.service.ts`.
- **Gemini is the ACTIVE free default;** Perplexity + OpenAI are DORMANT until keyed+enabled — the cron includes only enabled, keyed providers. Default: only Gemini.
- **Hard budget cap:** every engine call goes through the `ai-quota` guard (`assertAiQuota()` before, `isAiQuotaCapError(err)` → stop-the-sweep on catch); a failing/over-budget engine FAIL-SOFT skips and is recorded, never aborts the run.
- **Store enumeration filter:** `{ deletedAt: null, status: 'active', aiFeaturesEnabled: true, ...aiEligiblePlanFilter }` AND `answer_engine_insights` feature enabled per store.
- **Tenant isolation:** every `AnswerEngineCheck` row is `storeId`-scoped; the dashboard returns only the viewer's store (negative test required).
- **Untrusted engine output:** parse citations defensively (a malformed/empty engine response must not crash the job or fabricate a citation); render engine text as TEXT in the dashboard (no HTML injection).
- **Migrations hand-authored** — `migrate deploy` on a throwaway scratch DB; **NEVER `migrate dev`**; `@@map` snake_case table names; timestamp after `20260720000000`.
- **Zero-dep charts** — hand-rolled `SimpleBarChart`-style divs (mirror `apps/admin/.../analytics/_components/RevenueChart.tsx`); do NOT add a chart library.
- **Bilingual EN+AR** for all merchant/admin-facing strings.
- **commitlint** lowercase subject; blank line before `Co-Authored-By`; `git add` specific paths only. Typecheck + lint clean.
- **New deps discipline:** any new package registry-real, pinned, `npm audit` 0 new high/critical. (Perplexity/OpenAI via `fetch` — no SDK needed unless justified.)

---

## File Structure

**Create:**

- `apps/api/src/services/answer-engine/provider.ts` — `AnswerEngineProvider` interface + `EngineAnswer` type + citation-detection helper.
- `apps/api/src/services/answer-engine/gemini.provider.ts` — grounded Gemini adapter.
- `apps/api/src/services/answer-engine/perplexity.provider.ts` — Perplexity Sonar adapter (dormant).
- `apps/api/src/services/answer-engine/openai.provider.ts` — OpenAI adapter (dormant).
- `apps/api/src/services/answer-engine/registry.ts` — resolves ENABLED+keyed providers from config.
- `apps/api/src/services/answer-engine/prompts.ts` — buyer-intent prompt generation (auto + merchant overrides).
- `apps/api/src/services/answer-engine/config.service.ts` — encrypted provider-config CRUD (keys + toggles).
- `apps/api/src/lib/inngest/functions/answer-engine-citation-scan.ts` — the weekly cron + on-demand twin.
- `apps/api/src/routes/answer-engine.routes.ts` — merchant dashboard read API (store-scoped).
- `apps/api/src/routes/admin-answer-engine.routes.ts` — super-admin provider config API.
- `apps/admin/src/app/answer-engine-providers/page.tsx` — super-admin config placeholder page.
- `apps/admin/src/app/stores/[id]/answer-engine/page.tsx` (+ `_components/*`) — merchant dashboard.
- `packages/database/prisma/migrations/<ts>_answer_engine_check/migration.sql`.
- Tests under `apps/api/src/services/answer-engine/__tests__/` (unit) + `tests/integration/answer-engine/*` (integration).

**Modify:**

- `packages/shared/src/features.ts` + `plan-baselines.ts` — `answer_engine_insights` key.
- `packages/database/prisma/schema.prisma` — `AnswerEngineCheck` + `AnswerEngineProviderConfig` models.
- `apps/api/src/lib/inngest/functions/index.ts` + `client.ts` — register the cron + on-demand event.
- `apps/api/src/routes/index.ts` — mount the two new routers.
- `apps/api/src/config/index.ts` — (nothing new required for Gemini; provider keys come from DB config, not env).
- `docs/business/plan-feature-matrix.md`, `docs/ENVIRONMENT.md`.

---

## Task 1: Feature key `answer_engine_insights`

**Files:** `packages/shared/src/features.ts`, `packages/shared/src/plan-baselines.ts`, the shared features test.

**Interfaces:** Produces `'answer_engine_insights'` in `FeatureKey`; in `STARTER_CORE` (all paid plans, off free).

- [ ] **Step 1: Failing test** — add to the shared features test (mirror the `agent_checkout`/`agent_feed` assertions from item 7):

```ts
expect(FEATURE_KEYS_ARRAY).toContain('answer_engine_insights');
expect(FEATURE_REGISTRY.answer_engine_insights.key).toBe('answer_engine_insights');
expect(PLAN_BASELINE.starter).toContain('answer_engine_insights');
expect(PLAN_BASELINE.free).not.toContain('answer_engine_insights');
```

- [ ] **Step 2: Run → fails.** `npm run test:unit -w @ebda/shared -- features`
- [ ] **Step 3: Implement** — add `'answer_engine_insights'` to `FEATURE_KEYS_ARRAY` (near `agent_feed`), a `FEATURE_REGISTRY` entry (`name: 'Answer-Engine Insights'`, `nameAr: 'رؤى محركات الإجابة'`, description EN+AR about measuring AI answer-engine citations, `category: 'marketing'`, `tier: 'addon'`), and add it to `STARTER_CORE` in `plan-baselines.ts`.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(shared): add answer_engine_insights feature key`

---

## Task 2: Migration — `AnswerEngineCheck` + `AnswerEngineProviderConfig` models

**Files:** `packages/database/prisma/schema.prisma`, new migration dir.

**Interfaces:** Produces the two tables (append-only check rows + provider config).

- [ ] **Step 1: Edit schema** — mirror `FunnelSnapshot` style (`@@map` snake_case, `storeId @map("store_id")`, indexes, `onDelete: Cascade`):

```prisma
model AnswerEngineCheck {
  id             String   @id @default(uuid())
  storeId        String   @map("store_id")
  engine         String   // 'gemini' | 'perplexity' | 'openai'
  promptText     String   @map("prompt_text")
  locale         String   @default("en")
  cited          Boolean  @default(false)
  rank           Int?
  snippet        String?
  citedUrls      Json     @default("[]") @map("cited_urls")
  competitorUrls Json     @default("[]") @map("competitor_urls")
  runAt          DateTime @default(now()) @map("run_at")
  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)
  @@index([storeId, runAt(sort: Desc)])
  @@index([storeId, engine, runAt(sort: Desc)])
  @@map("answer_engine_checks")
}

model AnswerEngineProviderConfig {
  id           String   @id @default(uuid())
  engine       String   @unique // 'perplexity' | 'openai' (gemini needs no row — uses platform key)
  apiKey       String?  @map("api_key") // encrypted
  enabled      Boolean  @default(false)
  updatedAt    DateTime @updatedAt @map("updated_at")
  @@map("answer_engine_provider_configs")
}
```

Add the `answerEngineChecks AnswerEngineCheck[]` back-relation to `model Store`.

- [ ] **Step 2: Hand-author migration** `<ts>_answer_engine_check/migration.sql` (timestamp after `20260720000000`) — `CREATE TABLE "answer_engine_checks" (...)` + `"answer_engine_provider_configs" (...)` + indexes. Use the PHYSICAL snake_case table names (`@@map`), matching the item-2 lesson from item 7 (the schema `@@map` name, not the model name).
- [ ] **Step 3: Verify on a FRESH throwaway docker Postgres** (`migrate deploy` full chain; NEVER a real DB) → both tables exist, columns/defaults correct.
- [ ] **Step 4:** `npm run db:generate`.
- [ ] **Step 5: Commit** — `feat(database): add answer-engine check + provider-config tables`

---

## Task 3: Provider abstraction + Gemini grounded adapter + citation detection

**Files:** `provider.ts`, `gemini.provider.ts`, `__tests__/gemini.provider.test.ts`, `__tests__/citation.test.ts`.

**Interfaces:**

- Produces: `interface AnswerEngineProvider { engine: string; query(prompt: string): Promise<EngineAnswer> }`; `type EngineAnswer = { text: string; citedUrls: string[]; raw?: unknown }`; `detectCitation(store: {domain: string|null; brand?: string}, answer: EngineAnswer): { cited: boolean; rank?: number; snippet?: string; competitorUrls: string[] }`.

⚠️ **HIGHEST-RISK TASK — verify Gemini grounding feasibility FIRST.** Grounding is NOT used anywhere in the codebase; the installed SDK is `@google/generative-ai@0.24.1` and the default model is `gemini-flash-lite-latest`. Before building the adapter, VERIFY (read `node_modules/@google/generative-ai` types + a quick spike): does `getGenerativeModel({ model, tools: [{ googleSearch: {} }] })` compile + return grounding metadata on 0.24.1, and does the model support it? Three outcomes, pick per what you find and DOCUMENT it in the report:

- (a) Works on 0.24.1 with a grounding-capable model → use `tools: [{ googleSearch: {} }]`, read `response.candidates[].groundingMetadata.groundingChunks[].web.uri` for `citedUrls`.
- (b) 0.24.1 too old / flash-lite unsupported → use a grounding-capable Gemini model name via env (`ANSWER_ENGINE_GEMINI_MODEL`), still on 0.24.1 if the tool shape exists; if the SDK truly lacks it, add the newer `@google/genai` SDK as a scoped dep (pinned, audited) used ONLY by this provider.
- (c) Grounding genuinely unavailable → fall back to ungrounded `generateContent` and derive `citedUrls` by extracting URLs/brand mentions from the answer text, and RECORD a `grounded: false` marker so the dashboard can caveat "based on the model's knowledge, not live search." Do not silently ship a weaker signal as if it were grounded.

- [ ] **Step 1: Failing tests** — `detectCitation` unit tests (domain match in citedUrls → cited=true; brand mention in text → cited; competitor domains captured; empty/malformed answer → cited=false, no throw) + a Gemini adapter test with a MOCKED client returning a canned grounded response → asserts `citedUrls` parsed from grounding metadata.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** the interface + `detectCitation` (normalize domains: lowercase, strip `www.`, compare host; competitor = any cited host that isn't the store's) + the Gemini adapter (reuse `getClient()` pattern from `ai.service.ts`; call through `assertAiQuota()`; `recordUsage(storeId, 'answer_engine_gemini', in, out, false)`). Keep the client injectable for tests.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(api): answer-engine provider interface + grounded gemini adapter`

---

## Task 4: Perplexity + OpenAI adapters (dormant, keyed)

**Files:** `perplexity.provider.ts`, `openai.provider.ts`, `registry.ts`, `__tests__/*`.

**Interfaces:** Produces `getEnabledProviders(): Promise<AnswerEngineProvider[]>` — always includes Gemini (platform key present) + any `AnswerEngineProviderConfig` row with `enabled && apiKey`.

- [ ] **Step 1: Failing tests** — each adapter with mocked `fetch`: a canned API response → correct `EngineAnswer` + `citedUrls` (Perplexity returns `citations[]`; OpenAI via its response) . Registry test: with no config rows → only `['gemini']`; with an enabled+keyed perplexity row → `['gemini','perplexity']`; disabled or keyless → excluded.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** both adapters (`fetch` to the provider endpoint, key injected from decrypted config; map response → `EngineAnswer`) + `registry.ts` (reads `AnswerEngineProviderConfig`, decrypts key, filters enabled+keyed). Adapters take the key as a constructor arg (testable, no global).
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(api): perplexity + openai answer-engine adapters (dormant until keyed)`

---

## Task 5: Provider secret config service + super-admin config API + admin page

**Files:** `config.service.ts`, `admin-answer-engine.routes.ts`, `apps/admin/src/app/answer-engine-providers/page.tsx`, tests.

**Interfaces:** Produces encrypted CRUD for `AnswerEngineProviderConfig` (mask on read, encrypt on write, unchanged-if-`****`); super-admin routes `GET/PUT /admin/answer-engine/providers`.

- [ ] **Step 1: Failing integration test** — `PUT /admin/answer-engine/providers` with `{engine:'perplexity', apiKey:'pplx-secret', enabled:true}` stores an ENCRYPTED key (assert the DB value != plaintext) and `GET` returns it MASKED (`****`, never plaintext); a second `PUT` with the masked value does NOT clobber the stored secret; non-super-admin → 403. Mirror the `agent-feed`/`webhook-events` integration test harness + `payment-settings` masking behavior.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** `config.service.ts` (uses `encryption.encrypt`/`decrypt`/`mask`; `preserveMaskedPixelSecrets`-style merge) + the super-admin routes (`requireRole(['super_admin'])`, mounted under `/admin` like `admin.routes.ts`) + the admin page mirroring `webhook-events/page.tsx` (top-level route, `AdminLayout`, `apiGet`/`apiPut`) — a masked key field + enabled toggle per engine, bilingual.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat: super-admin answer-engine provider config (encrypted keys + toggle)`

---

## Task 6: Citation-scan Inngest cron (money/quota path)

**Files:** `answer-engine-citation-scan.ts`, `prompts.ts`, `functions/index.ts`, `client.ts`, tests.

**Interfaces:** Produces `answerEngineCitationScanCron` + `answerEngineScanOnDemand` (event `answer-engine/scan-requested`, `{storeId}`).

- [ ] **Step 1: Failing integration test** — seed an AI-eligible store with `answer_engine_insights` enabled + a product/category; invoke the on-demand scan; assert `AnswerEngineCheck` rows are written for `gemini` (mock the provider client to a canned grounded answer citing the store's domain) with `cited=true`; a store WITHOUT the feature → zero rows (skipped); a disabled provider → not queried.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — `prompts.ts` (generate buyer-intent prompts per store from its categories/top products, EN+AR; merge merchant overrides if present); the cron (mirror `stock-reorder-scan.ts`: enumerate stores with the §Global-Constraints filter inside `step.run('list-stores')`, batch via `chunk`/`BULK_AI_BATCH_SIZE`, per-store `step.run` gated on `featureService.isFeatureEnabled(storeId,'answer_engine_insights')` + `runInTenantContext`; for each enabled provider × prompt: `assertAiQuota()` → `provider.query()` → `detectCitation()` → write row; on `isAiQuotaCapError` stop this store's remaining calls; fail-soft skip a throwing provider and record it). Register in `functions/index.ts` + add the on-demand event to the `AppEvent` union in `client.ts`. Add a `// INNGEST_DEPLOY_ID note` comment (new cron invisible to Inngest until a deploy bumps the version).
- [ ] **Step 4: Run → passes.** (Integration test drives the on-demand twin so no real cron wait.)
- [ ] **Step 5: Commit** — `feat(api): weekly answer-engine citation-scan cron + prompt generation`

---

## Task 7: Merchant dashboard API + admin page + docs + blast-radius

**Files:** `answer-engine.routes.ts`, `apps/admin/src/app/stores/[id]/answer-engine/page.tsx` (+ `_components/*`), `docs/*`, tests.

**Interfaces:** Consumes `AnswerEngineCheck` rows; produces `GET /stores/:storeId/answer-engine/summary` (+ trend/prompts).

- [ ] **Step 1: Failing integration test** — with seeded checks for store A, `GET /stores/:A/answer-engine/summary` returns A's cited-count/trend/per-prompt-win-loss; a viewer scoped to store B gets B's data only (tenant-isolation negative test — A's rows never returned to B); feature-off store → 404/empty.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — read routes (`authenticate → requirePermission('analytics:read') → requireStoreAccess`, cache-aside via `getCachedAnalytics` ≥120s TTL) returning aggregates (cited count per engine, week-over-week trend, per-prompt win/lose vs competitors, `grounded` caveat if the Gemini fallback was used); the admin dashboard page (mirror `stores/[id]/analytics/page.tsx` + a zero-dep `SimpleBarChart`-style component; bilingual; each "not cited" prompt shows a rec that deep-links to the matching `bulk-ai-geo` sweep, e.g. add-FAQ/citation-copy). Gate on `answer_engine_insights`.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Docs + blast-radius** — `docs/ENVIRONMENT.md` (new: `ANSWER_ENGINE_GEMINI_MODEL?`, per-engine budget cap envs if added; provider API keys are DB-config, note that); `docs/business/plan-feature-matrix.md` row; blast-radius sweep (`answer_engine_insights`, the two new models + every reader/writer + the UI surface, the new routes, the cron registration, `AnswerEngineProviderConfig` consumers) — state the result.
- [ ] **Step 6: Commit** — `feat: answer-engine merchant dashboard + docs`

---

## Final verification (before PR)

- [ ] `npm run typecheck`, `npm run lint` clean; the answer-engine unit + integration suites green; `npm run test:unit -w @ebda/shared` green.
- [ ] `npm audit --omit=dev --audit-level=high` — 0 new high/critical.
- [ ] Whole-branch review (Opus): grounding-fallback correctness, secret masking (no plaintext key ever returned/logged), budget-guard fail-soft, tenant isolation on the dashboard, untrusted-output handling.
- [ ] Blast-radius statement in the PR body. PR → main, NOT merged (deploy-all-at-once batch).

## Notes for Plan 8B (GSC — separate plan)

- Reuses the `answer_engine_insights` feature key + the dashboard shell (adds a GSC section/tab).
- New: Force-managed GSC credential (service account or stored OAuth refresh token — platform secret), a `googleapis`/REST GSC client, a `GscDailyMetric` model (aggregate, mirror `ProductDailyView`), a daily ingestion cron mapping `Store.domain` → GSC property, mocked-GSC tests.
