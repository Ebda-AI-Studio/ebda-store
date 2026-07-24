# Answer-Engine / Citation Measurement ("Answer-Engine Insights") — Design Spec

**Status:** approved-in-principle (Ahmad, 2026-07-22) — pending written-spec review.
**Item:** OSOSS competitive program, item 8 ("answer-engine / citation measurement").
**Thesis fit:** "win on AI / AEO." The platform already helps merchants _get citable_ (JSON-LD,
sitemap, AEO/GEO content sweeps); this measures whether AI answer engines actually _surface_ them,
closing the loop from "we optimized" to "here's the proof / here's what to fix next."
**Branch/worktree:** `feat/answer-engine-insights` → `_worktrees/force-website-builder__feat-answer-engine-insights`.
**Deploy:** develop-now, merges in the deploy-all-at-once batch.

---

## 1. Problem & premise (verified against source, 2026-07-22)

The _content/discoverability_ side is mature and shipped: JSON-LD builders
(`apps/web/src/lib/structured-data.ts`), host-aware sitemap (`apps/web/src/app/sitemap.ts`),
AI-crawler robots (`apps/web/src/app/robots.ts`), 3-level `llms.txt`
(`apps/web/src/app/llms.txt/route.ts`), and AI content sweeps that _write_ citable copy
(`bulk-ai-aeo.ts`, `bulk-ai-geo.ts`, `product-meta-aeo-generator.ts`).

**The gap:** nothing _measures_ whether an answer engine actually surfaces/cites a merchant. There
is no citation data model, no polling job, no merchant-facing "you were cited N times" surface, and
no ingestion of the one real first-party signal (Google Search Console). This feature builds that
measurement half. Reusable infra already present: cron-triggered Inngest jobs
(`analytics-daily-rollup.ts`), the AI budget/quota guard (`ai-quota.ts`), the analytics
service + admin dashboard pattern (`analytics.service.ts`, `apps/admin/.../stores/[id]/analytics/`).

## 2. Goal

Give each merchant a measured view of their AI answer-engine visibility, from two independent
signals, surfaced in an admin dashboard with actionable recommendations:

- **Subsystem A — Prompt-based citation checking (direct AEO measurement).** On a schedule, run
  buyer-intent prompts through answer engines and record whether the merchant's brand/domain/products
  are cited, vs competitors.
- **Subsystem B — Google Search Console ingestion (official first-party signal).** Pull GSC Search
  Analytics (impressions/clicks/queries) for each store's domain and trend it.

**Decisions (Ahmad, 2026-07-22):**

- **Build ALL three engine adapters** (Gemini, Perplexity, OpenAI) as **pluggable providers**, but
  **Gemini (Google Search grounding) is the ACTIVE, free default.** Perplexity + OpenAI ship built +
  tested but **dormant** until an admin enters their API key and toggles them on — no redeploy to flip.
- **Admin placeholder UI** to set each engine's API key + enabled flag "anytime."
- **GSC is Force-managed** (not per-merchant OAuth): merchant domains are linked under Force's own
  Google Search Console; ingestion uses ONE Force-managed connection and maps metrics to stores by
  domain.
- Paid-provider spend is bounded by a hard budget cap; rough estimate at 100 stores ≈ $30–80/mo total
  if both paid engines are enabled — exact rates to confirm before enabling.

Non-goals (v1): SERP scraping of Google AI Overviews; per-merchant GSC OAuth; real-time (on-demand)
checks (scheduled only); rewriting the existing content sweeps (we _link_ to them from recs).

## 3. Architecture

### 3a. Subsystem A — Answer-engine provider abstraction + citation-check job

- **Provider interface** `AnswerEngineProvider` with method `query(prompt): Promise<EngineAnswer>`
  where `EngineAnswer = { text, citedUrls: string[], raw }`. Three adapters:
  - `gemini` — calls Gemini with the **Google Search grounding tool**; `citedUrls` comes from the
    response's grounding metadata (the source URLs the model used). ACTIVE by default; uses the
    existing Gemini key + `ai-quota.ts` budget guard.
  - `perplexity` — Perplexity Sonar API (native grounded answer + citations). DORMANT until keyed.
  - `openai` — OpenAI (model + web-search tool). DORMANT until keyed.
- **Provider registry / config:** which engines are enabled + their API keys are read from an admin
  Setting (see 3c). The job iterates only ENABLED, keyed providers. Gemini is enabled by default; the
  paid two default to disabled/keyless (dormant but code-complete + unit-tested with a mocked client).
- **Prompts:** a set of buyer-intent prompts per store, **auto-generated** from the store's
  categories/top products (e.g. "best {category} in {country}", "where to buy {product} in Kuwait"),
  with an **optional merchant-editable** override list. Latin + Arabic variants.
- **Citation detection:** for each (prompt, engine), mark `cited=true` if the store's domain (or a
  configured brand alias) appears in `citedUrls` (grounding sources) or the answer text mentions the
  brand/product. Also capture competitor domains cited on the same prompt (for "you lost this query").
- **Scheduling + budget:** an Inngest cron (weekly per store, staggered) mirroring
  `analytics-daily-rollup.ts`. Each engine call goes through a budget guard extending `ai-quota.ts`
  (per-engine daily/monthly cap + per-store cadence). A dead/over-budget engine is SKIPPED, never
  blocks the run (fail-soft), and the skip is recorded.

### 3b. Subsystem B — Force-managed GSC ingestion

- One Force-managed GSC credential (service account or a Force OAuth refresh token stored as a
  platform secret) with access to the Force-owned properties covering merchant domains.
- A daily/weekly Inngest job calls the **GSC Search Analytics API** per store domain, pulls
  impressions/clicks/CTR/position + top queries, and writes a `GscDailyMetric` snapshot per store.
- Store↔property mapping is by domain (a store's resolved custom domain / `store.domain`); stores
  with no linked property are simply skipped (recorded as "GSC not connected").

### 3c. Admin config placeholder (the "set anytime" surface)

- A **super-admin / platform** settings surface (this is platform-level config, NOT per-merchant):
  for each answer engine — an API-key field (write-only/masked) + an "enabled" toggle; plus the GSC
  connection status. Backed by a `Setting` row (keys masked in responses; never logged).
- Flipping an engine on (key present + enabled) makes the next cron run include it — no deploy.
- Reuses the existing `Setting` key/value + admin settings patterns; secrets handled per the repo's
  secret-storage convention (confirm at plan time — likely env for the GSC platform credential, and a
  masked `Setting`/encrypted column for provider keys).

### 3d. Data model (append-only)

- `AnswerEngineCheck` — one row per (storeId, engine, prompt, runAt): `cited` bool, `rank?`,
  `snippet?`, `citedUrls` json, `competitorUrls` json, `promptText`, `locale`. Append-only.
- `GscDailyMetric` — per (storeId, date): impressions, clicks, ctr, avgPosition, topQueries json.
- Optional roll-up view/table for the dashboard (share-of-voice, week-over-week). Alongside existing
  analytics tables; every table gets a UI surface (§3e).

### 3e. Merchant dashboard (the deliverable — every-data-needs-a-UI)

Extends `apps/admin/.../stores/[id]/analytics/` (or a sibling `/answer-engine` page):

- "Cited N times this week" per engine + trend over time.
- Per-prompt win/lose vs competitors ("You were NOT cited for 'best perfume Kuwait' — competitor X
  was").
- GSC impressions/clicks/top-queries trend.
- **Actionable recs** linking back to the existing AEO/GEO content sweeps ("add an FAQ block for this
  query" → deep-link to the bulk-AI-AEO action). Bilingual (EN+AR).

### 3f. Entitlement

- New `answer_engine_insights` feature key — all paid plans (AI-first policy), off on free. Gates the
  cron (skip stores without it), the dashboard, and the API.

## 4. Security & guardrails

- Provider API keys are secrets: masked in all responses, never logged, stored per repo convention.
- The GSC platform credential is a platform secret (not per-tenant); ingestion is store-scoped on
  write (each metric row carries `storeId`).
- Budget caps are HARD (extend `ai-quota.ts`); an over-budget or failing engine fail-soft skips.
- Tenant isolation: every check/metric row is `storeId`-scoped; the dashboard reads only the viewer's
  store (same `requireStoreAccess` pattern as existing analytics).
- Prompt inputs to engines are derived from store data — validate/escape; treat engine responses as
  untrusted text (no HTML injection into the dashboard; render as text).
- LLM output validation: parse citations defensively (a malformed engine response must not crash the
  job or fabricate a citation) — follow the existing FAQ-grounding/LLM-output-validation discipline.

## 5. Testing

- **Unit:** each provider adapter (mocked client → correct `EngineAnswer`/`citedUrls` parse, incl.
  Gemini grounding-metadata extraction); citation-detection logic (domain/brand match, competitor
  capture, malformed-response safety); budget-guard skip; prompt auto-generation.
- **Integration (Postgres):** the cron writes `AnswerEngineCheck`/`GscDailyMetric` rows for an
  entitled store and skips a non-entitled one; provider-disabled/keyless engine is skipped; the
  dashboard API returns store-scoped rows only (tenant-isolation negative test — foreign store's data
  never returned).
- **GSC:** ingestion against a mocked GSC client (no live Google call in CI); domain→store mapping;
  unmapped-domain skip.
- **Admin config:** enabling a keyed engine includes it next run; keys are masked in responses.
- **Blast-radius:** new feature key (registry + baselines + matrix), new models (migrations + every
  reader/writer + a UI surface each), new Inngest jobs (registration in `client.ts`), new env/secret
  keys (documented in `docs/ENVIRONMENT.md`).

## 6. Open items to resolve during planning (not blockers)

- Exact Gemini grounding API shape in the installed SDK (grounding tool config + how `citedUrls` /
  `groundingChunks` are returned) — confirm against the model FWB uses (may need a grounding-capable
  Gemini model, not necessarily flash-lite).
- Provider API-key storage: masked `Setting` vs an encrypted column (repo convention).
- GSC credential form: service account (domain-delegated) vs a stored Force OAuth refresh token —
  and the exact `searchanalytics.query` scopes; confirm which Force account owns the properties.
- Cadence + budget-cap default values (weekly/store; per-engine monthly cap).
- Whether the dashboard is a new `/answer-engine` page or a tab under existing analytics (UX/altitude
  ceiling rules).
