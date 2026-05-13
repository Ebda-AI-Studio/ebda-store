# Iceberg Audit follow-up plan v2 — item-by-item triage

**Supersedes** `2026-05-13-iceberg-audit-followup.md` (v1). v1 kept the session structure; v2 adds the real-life impact + choice list per gap so Ahmad can triage with full context.

For each gap below: **Status** → **Real-life impact** (what breaks if we don't fix it) → **Options** (cheap → thorough) → **Recommended choice**. After all items, the sequenced execution plan groups them into shippable sessions.

Status legend: ⚠️ Partial · ❌ Missing · 13 partials + 8 missing = **21 items to address**.

---

## Tier 1 — Regulatory + operational liability (do first)

These are actively at risk RIGHT NOW. Every day Wady Aljuz takes another order, the exposure compounds.

### 35. Cookies — ❌ Missing

**Real-life impact**: Marketing pixels (Meta, GA4, TikTok, Snapchat, Twitter, Pinterest) fire on every storefront page load without user consent. Under GDPR Art. 6(a) + ePrivacy Directive + Kuwait Law 13/2023, this is a regulatory violation per visitor. Concrete consequences: (a) any visitor or competitor can file a complaint with the Kuwait Data Protection Authority → investigation + fine (up to 5M KWD or 5% global revenue, whichever is higher); (b) Google flags the site during ad account review → ads paused until consent banner added (typically 7-14 day disruption); (c) if Wady Aljuz expands to EU customers, single GDPR complaint triggers €20M / 4% global revenue cap; (d) Meta's pixel terms require "valid legal basis for processing" — they can disable the pixel ID on report.

**Options**:

- **A. Custom 4-hour build** (recommended): `CookieConsentBanner` component + `force-cookie-consent` cookie + gate `MarketingPixelsProvider`. Three-option modal: Accept all / Reject all / Customize. Mirrors the `force-language` cookie pattern from `feedback-locale-cookie-ssr.md`. EN/AR bilingual. Total: ~200 lines.
- **B. Drop-in library** (`vanilla-cookieconsent` or `cookieconsent` from Osano, ~6KB): faster integration (~1 hour) but adds an external dep + their UI doesn't match FWB's design.
- **C. Server-side consent gating**: read consent cookie in `layout.tsx` SSR pass, never even SEND pixel scripts to non-consenting browsers. Slightly more secure (no client-side races) + better Lighthouse score, but more invasive.

**Recommendation**: **A** for full control + design consistency. Bake the SSR check from C into A from day 1 since we already proved that pattern with the locale cookie.

---

### 16. GDPR/CCPA — ⚠️ Partial

**Real-life impact**: `DELETE /auth/me` soft-deletes (`deletedAt`) but leaves email, phone, name, address, order PII fully intact in the DB. GDPR Art. 17 (Right to Erasure) requires irreversible anonymization, not hiding. A single customer email asking "please delete my data" that gets a partial response = formal complaint material. Penalty: same scale as #35 above. Bonus consequence: Kuwait Law 13/2023 also requires data export on request (Art. 20 portability) — FWB has zero mechanism for this. Customer asks "send me my data" → no response possible without DB direct access.

**Options**:

- **A. Full erase + export endpoints** (recommended): `POST /auth/me/erase` (NULLs PII in transaction; preserves anonymized orders for tax records) + `GET /auth/me/export` (returns JSON bundle of all PII). Plus admin override at `/admin/customers/[id]` so super_admin can trigger erasure on behalf of email-based request. ~6 hours.
- **B. Manual SOP**: document a "if customer requests erasure, run this SQL" runbook. Cheap (1 hour) but doesn't scale, error-prone, and fails Art. 12 (response time + verification requirements).
- **C. Erase-only, skip export**: ship A's erase endpoint, defer export to "when first requested". Risky — Art. 20 requires response within 30 days; if request lands without endpoint ready, you're scrambling.

**Recommendation**: **A**. The full scope is one focused session; cutting corners here invites the same regulatory exposure as #35.

---

### 12. Alerting — ❌ Missing

**Real-life impact**: Site can go down at 3am with zero notification. Recent precedent: the day FWB's Railway API crashed for 12 minutes in March 2026 — discovery was a merchant WhatsApp message. Sentry catches errors but doesn't tell you "the server is unreachable". A payment provider HMAC misconfiguration could silently 401 every webhook for hours before anyone notices. Concrete impact: for every hour of unmonitored downtime, you lose ~50-200 KWD in orders (Wady Aljuz averages) AND erode merchant trust ("their platform is unreliable") AND give competitors talking points. For multi-merchant future, downtime = SLA breach = potential contract penalty.

**Options**:

- **A. UptimeRobot + Telegram (free)** (recommended): 5-min checks on `/health` for all 3 deploys (API + admin + storefront) → Telegram bot DM. Setup: 15 min in their dashboard. No code. Free tier: 50 monitors, 5-min intervals.
- **B. BetterUptime / Pulsetic (free tier)**: same as A but with status-page integration built in (kills two birds — also addresses #33). 30 min setup.
- **C. Proper APM (Datadog/New Relic free tier)**: heavyweight, ~2-3 hours setup, $50-150/mo when you outgrow free. Overkill for current scale.

**Recommendation**: **B** — UptimeRobot is free + standalone but BetterUptime's free tier includes a status page which solves #33 in the same dashboard.

---

### 11. Logging persistence — ⚠️ Partial

**Real-life impact**: Railway's stdout buffer holds logs for ~72 hours. After that they're gone. Any post-incident investigation older than 3 days is impossible — you can't reconstruct what went wrong if you find out a week later. Concrete consequence: when a merchant reports "an order from last weekend didn't fire the confirmation email" on a Monday, the relevant logs are already gone. Same for security forensics — if there's a credential leak attempt 5 days ago, you can't trace it. Pino structured logs already exist; they just evaporate.

**Options**:

- **A. BetterStack log drain (free)** (recommended): 3 GB/30 day retention free. Railway → Settings → Log Drains → paste URL. 15 min. Live search + structured queries on the structured JSON pino emits.
- **B. Axiom (free)**: 0.5 TB / 30 day on free plan. Heavier UI, more powerful query language (APL). 20 min setup.
- **C. Self-hosted (Loki + Grafana)**: zero ongoing cost but ~4 hours setup + ongoing maintenance of yet another service. Reject.

**Recommendation**: **A** — BetterStack free tier is sufficient for current volume + integrates well with their uptime monitoring from option 12B above.

---

### 27. Cloud costs — ❌ Missing

**Real-life impact**: A runaway loop, traffic spike, or bot scrape could exhaust Railway compute, Neon compute credits, or Vercel function invocations with no warning until the bill hits or service degrades. Real precedent: A Gemini AI sweep accidentally triggered 200x its normal cost on day one of bulk AI rollout (caught via `feedback-bulk-ai-transient-retry.md`). At current scale you're spending ~$50-100/mo across stack; an unbounded incident could 10x that to $500-1000 before discovery. Hobby Vercel auto-suspends at hard cap → site goes 503 with no proactive notice if you haven't set a soft alert.

**Options**:

- **A. Native dashboard alerts** (recommended, free): Railway → Project Settings → Budget alerts (80% threshold) + Vercel → Spending limit (Hobby has hard cap; set soft alert at 80%) + Neon → email alert at 80% compute credits. ~10 min total across all three. Zero code.
- **B. AI quota guards in code**: already implemented for Gemini (`AI_DAILY_REQUEST_CAP`, `AI_MONTHLY_REQUEST_CAP`). Extend the pattern to OneSignal API quotas + Resend daily email cap.
- **C. Full cost observability tool** (Vantage, Cloudability): overkill for current scale. ~$200/mo + setup.

**Recommendation**: **A + B**. Dashboards take 10 min and cover the "runaway provider" case. Code-level quota guards complement for the "runaway code" case.

---

## Tier 2 — Architectural debt (compounds over time)

These don't break today, but every week without them increases the cost of fixing them later.

### 19. Environments — ⚠️ Partial

**Real-life impact**: Vercel preview deployments (every PR + every push to feature branches) currently point at the PRODUCTION Railway API. Every preview build can mutate production data — orders, customers, payment configs. The E2E test suite already does this, intentionally, against the live Neon DB. Concrete consequence: a developer running E2E locally or in CI can accidentally create test orders in production, send real emails to Wady Aljuz's customers, fire real payment provider invoices. We've already had to add cleanup helpers (`tests/e2e/cleanup.ts`) precisely because this happens.

**Options**:

- **A. Full staging environment** (recommended): new Railway service `api-staging` + Neon branch `staging` + Vercel preview env `NEXT_PUBLIC_API_URL = staging`. ~3 days but it's the right answer.
- **B. Neon branch for E2E only**: cheaper (~1 day) — keep preview pointing at prod API but isolate E2E suite to a dedicated Neon branch. Doesn't solve preview-deploy mutations.
- **C. Read-only seeded test fixtures**: only safe if all E2E + preview interactions are read-only. Most aren't.

**Recommendation**: **A**. The 3-day cost saves a multi-week migration when FWB onboards merchant #2 and the "tests writing to prod" pattern stops being tenable.

---

### 23. Instrumentation — ⚠️ Partial

**Real-life impact**: Sentry catches errors + profiles transactions at 10% sampling. There's no visibility into: Inngest queue depth (a stuck job goes unnoticed until merchant complaint), Redis connection status (cache misses cascade silently), Neon connection pool saturation (the "P1001 connection closed" errors in logs hint at this), email queue backlog. Concrete consequence: when payment webhooks pile up because Inngest is stalled (already happened — see `feedback-inngest-deploy-sync-trap.md`), there's no metric to alert on. You find out after the fact when orders aren't being confirmed.

**Options**:

- **A. `/health/detail` endpoint** (recommended): admin-auth-only endpoint returning Inngest queue depth, Redis ping, last Neon query duration, Sentry sample rate. ~30 min. Then add UptimeRobot keyword-match alert on it.
- **B. OpenTelemetry + a backend** (Honeycomb / Grafana Cloud): proper distributed tracing. ~2 days setup + ongoing cost. Worth it at 10x current scale.
- **C. Prometheus + Grafana self-hosted**: zero cost but adds infrastructure burden. Reject for solo-developer scale.

**Recommendation**: **A**. Tiny code change, surfaces the 4 metrics most likely to fire before customers notice. Revisit B at higher scale.

---

### 8. Scalability + 10. Load balancing — ⚠️ Partial (paired)

**Real-life impact**: Single Railway API replica handles all traffic. Any deploy = ~30s downtime (Hobby plan, no rolling deploys). Any crash = 100% outage until Railway restarts. Current capacity: ~190 req/s sustained — handles Wady Aljuz fine but can't accommodate a multi-merchant catalog burst (e.g. 5 merchants running flash sales same hour). API throughput ceiling becomes a launch-blocker the moment merchant count hits ~3-5.

**Options**:

- **A. Railway Pro + multi-replica** (recommended at scale-trigger): ~$20/mo. Configures rolling deploy + 2+ replicas. Solves both scalability + load balancing in one step.
- **B. Edge-cache the public read paths** (cheaper, defers Pro upgrade): aggressive Vercel edge cache for all `GET /api/v1/public/*` endpoints + tag-based invalidation. ~2-3 days. Buys you ~10x more public-read throughput without paying Railway Pro yet.
- **C. Stay on single instance + monitor**: cheapest. Accept ~30s deploy downtime + single-point-of-failure risk. Fine for current scale but ticks a clock.

**Recommendation**: **C → B → A** progression. Stay on C today. Move to B when merchant #2 onboards. Move to A when sustained traffic hits 100 req/s.

---

### 22. Test coverage — ⚠️ Partial (50% floor)

**Real-life impact**: 50% coverage threshold means half the codebase is untested. For a payment-handling platform, the cost of an untested regression in `order.service.ts` or `webhook.routes.ts` is a real failed transaction → customer complaint → merchant trust erosion. Recent precedent: the storeId-passthrough bugs from 2026-05-13 (`feedback-payment-listing-bugs-2026-05-12.md`) — payment listing returned empty `providers: []` for two months because no test covered the per-store factory path. If coverage were at 70%, that bug never ships.

**Options**:

- **A. Targeted lift to 70%** (recommended): focus on `order.service.ts`, `payment.routes.ts`, `webhook.routes.ts`, `auth.service.ts`. ~3 days writing tests. Then bump vitest.config.ts thresholds: lines 50→70, branches 40→60.
- **B. Full 80% threshold across all files**: ~1-2 weeks. Diminishing returns on UI components and trivial CRUD.
- **C. Critical-path-only e2e tests**: write 5-10 high-value e2e tests covering checkout, refund, multi-tenant isolation. Cheaper (~1 day) but doesn't catch unit-level regressions.

**Recommendation**: **A**. The four files account for ~80% of FWB's customer-facing risk surface.

---

## Tier 3 — Compliance hardening (less urgent but legally needed)

### 15. Data retention — ⚠️ Partial

**Real-life impact**: Audit log retention is implemented (90d → R2 archive) — good. But abandoned carts, soft-deleted users, and customer PII accumulate forever. Kuwait MOF requires invoice retention ≥5 years for tax compliance, but Kuwait Law 13/2023 also requires _not_ retaining PII beyond business need. The conflict means orders should be anonymized at 5+ years, not kept with PII. Abandoned carts older than 30 days serve zero business purpose and grow DB cost. Concrete impact: a year from now your `Cart` table has 100K rows of dead data slowing every query.

**Options**:

- **A. Two Inngest crons** (recommended): `abandoned-cart-purge` (weekly: delete carts older than 30d with no customerId) + `soft-deleted-user-anonymize` (monthly: anonymize Users with `deletedAt` older than 12 months — reuses the `/auth/me/erase` logic from #16). ~2 hours.
- **B. Manual SOP**: document the SQL to run on a schedule. Cheap but error-prone, frequently skipped.
- **C. Comprehensive retention matrix**: write a `docs/RETENTION.md` covering every PII column with its retention SLA + automation. ~1 day. Belt-and-suspenders for future compliance audits.

**Recommendation**: **A + C**. Crons are the working code; the doc is the policy artifact a regulator asks for.

---

### 32. Governance — ⚠️ Partial

**Real-life impact**: No branch protection on `main`. Anyone with push access (you, friend) can push directly without PR review. With friend joining the new project, this is the moment to add protection — accidental force-push or `--no-verify` skip is now a real risk. Concrete consequence: an unreviewed migration push could corrupt the schema; a `--no-verify` push could ship secrets to a public log.

**Options**:

- **A. Branch protection on main** (recommended): GitHub → repo settings → branches → protect `main` → require PR + 1 approval (you can self-approve as the repo owner via the "Allow specified actors to bypass" exception list, but the friend cannot). 5 min per repo.
- **B. Pre-receive hook on Railway-deployed projects**: blocks pushes that contain certain patterns (force-push, --no-verify markers). More complex; rarely needed.
- **C. No change**: trust the operators. Acceptable today; not when merchant count grows.

**Recommendation**: **A** on all 5 repos (FWB, CRM, WBS, Landing, claude-memory-vault). 25 min total.

---

### 30. Support ops + 31. Escalations — ❌ Missing (paired)

**Real-life impact**: Merchants reporting issues via WhatsApp = no ticket trail, no resolution history, no SLA. As merchant count grows, this becomes operationally untenable. Concrete consequence: a recurring bug gets reported 3 times to Ahmad over a month with no record → wastes time re-debugging → merchant frustration. For escalations (P0 paging), the same gap — there's no formal "raise to P0" channel beyond WhatsApp.

**Options**:

- **A. Crisp chat widget on admin app** (recommended): free tier covers 1 operator + unlimited conversations. Drop a `<Script>` in `apps/admin/src/app/layout.tsx`. Adds a chat bubble for merchants. Conversation history persisted in Crisp dashboard. ~15 min. Combined with the Telegram alert from #12 covers escalations too (P0 alerts → Telegram, merchant tickets → Crisp).
- **B. Lightweight ticketing (Linear, Plain)**: more structured but more setup. ~2 hours + ongoing curation.
- **C. Email-only**: rely on `support@forcemediakw.com`. Cheap, but no history visibility, no SLA tracking.

**Recommendation**: **A**. Crisp is the standard solo-operator support tool. Move to B when merchant count > 5.

---

### 33. Platform support (status page) — ⚠️ Partial

**Real-life impact**: Merchants have no visibility into platform health. When you deploy, they don't know. When there's an outage, they have to ask. Concrete consequence: maintenance windows are surprises; outages feel longer than they are because there's no "we know, we're fixing" signal.

**Options**:

- **A. BetterUptime status page** (recommended — already chosen via #12 option B): free; auto-updates from the uptime monitors. Add a "Status" link to admin header. 5 min.
- **B. Self-hosted statuspage** (Cachet, Atlassian Statuspage free): more control, more effort. Reject.
- **C. Defer**: tolerable while merchant count is 1.

**Recommendation**: **A** — landed automatically when you set up #12 with BetterUptime.

---

## Tier 4 — Growth + strategic

### 26. Churn control (merchant-side) — ⚠️ Partial

**Real-life impact**: Customer-side churn (loyalty + push re-engagement) is covered. Merchant-side has zero signal — a store going dark (no orders for 30d, no admin logins for 14d) generates no alert. Concrete consequence: by the time you notice a merchant is gone, they've already decided to leave. Win-back becomes much harder. Particularly important once you onboard merchant #2+ and can't manually watch each.

**Options**:

- **A. Weekly platform heartbeat cron** (recommended): Inngest function that queries stores with zero orders in 30d AND no admin login in 14d → emails / Telegrams the super_admin (you) with a manual action queue. ~2 hours.
- **B. Full merchant CRM with health-score model**: HubSpot-style. Premature at current scale.

**Recommendation**: **A** when merchant #2 onboards. Skip for now (manual watch of 1 merchant is fine).

---

### 34. Adtech CAPI — ✅ but with CAPI gap

**Real-life impact**: Client-side Meta/TikTok pixels are blocked for 30-40% of users (ad blockers, iOS ITP, browser privacy mode). That's lost attribution → ads optimize against incomplete data → CAC goes up. Concrete consequence: Meta's algorithm under-allocates budget to ads that ARE converting because it can't see the conversions. Real measured impact: server-side CAPI typically recovers 15-30% of attribution.

**Options**:

- **A. Meta Conversions API only** (recommended for now): server-side service fires from `handleWebhook` on payment success. Covers Meta which is the biggest ad spend. ~1 day.
- **B. Multi-platform server pixels**: Meta CAPI + TikTok Events API + Snapchat CAPI. ~2-3 days.
- **C. Defer**: only worth it if running paid ads. If Wady Aljuz isn't currently paying for ads, defer until they start.

**Recommendation**: **A** if any paid ad budget is active for Wady Aljuz. **C** if organic-only.

---

### 38. A/B testing — ❌ Missing

**Real-life impact**: Every UI/copy/pricing decision is by gut feel. Concrete consequence: launched Hero variant A → assumes it works → never tests variant B that could be 20% better conversion. At the merchant's scale (single store, moderate traffic), one good A/B test pays for the whole tooling effort.

**Options**:

- **A. PostHog free tier** (recommended): 1M events/month free. Install `posthog-js`, wire to existing FeatureContext. ~4 hours.
- **B. GrowthBook self-hosted**: zero cost, more setup. Overkill.
- **C. Custom feature-flag-based experiments**: FWB already has `FeatureContext`. Adding variant assignment + analytics + significance check is 1-2 days of bespoke work that PostHog gives for free.

**Recommendation**: **A**. Depends on cookie consent (#35) being live so analytics are GDPR-compliant.

---

### 3. Billing logic (platform → merchant) — ⚠️ Partial

**Real-life impact**: `StorePlan` exists in schema but assignment is manual. As merchant count grows past ~3, you can't manually invoice each one without dropping balls. Today: zero merchants paying monthly fees → manual is fine. Tomorrow: 10 merchants × ~50 KWD/mo each = $500/mo revenue you can't reliably collect without automation. Concrete consequence: merchants stay on free indefinitely because there's no payment mechanism to upgrade them.

**Options**:

- **A. Stripe Billing** (recommended at scale): `StoreSubscription` table + Stripe Checkout for subscription signup + webhook for lifecycle events + dunning. ~1 week.
- **B. MyFatoorah recurring invoicing**: keeps everything Kuwait-native. ~1-2 weeks. Worse Stripe-Billing-style UX.
- **C. Manual + email invoices**: tolerable until merchant #5.

**Recommendation**: **C** today. **A** when merchant #3 signs up.

---

### 37. Documentation — ⚠️ Partial

**Real-life impact**: Developer docs (CLAUDE.md, ROLLBACK.md, INCIDENT.md, perf audits) are excellent. Merchant-facing docs are zero. A new merchant onboarding has nothing to read — every question becomes a WhatsApp message to you. Concrete consequence: onboarding takes hours of your time per merchant. Self-service is impossible.

**Options**:

- **A. Notion/GitBook public docs site at `docs.forcemediakw.com`** (recommended): topics — payment provider setup, custom domain wiring, product management, order workflow, AI sweep guide. ~2-3 days writing.
- **B. In-app docs (admin sidebar links)**: cheaper but no SEO. Merchants Google instead.
- **C. Loom video library**: 5-10 short walkthroughs. ~1 day. Lower friction to create, lower discoverability.

**Recommendation**: **A** when merchant #2 onboards. Until then, you're handling support 1-on-1 which is fine.

---

### 28. Multi-region — ❌ Missing

**Real-life impact**: API is single-region (currently `ap-southeast-1` per DATABASE_URL — Singapore). Kuwait-market users hit a Singapore server → ~150ms RTT per uncached API call. Acceptable today; suboptimal compared to a Bahrain/UAE region (~30ms).

**Options**:

- **A. Move Railway region to closer location** (Frankfurt or US-East, whichever Railway offers nearest to Kuwait): one-time migration, ~2 hours.
- **B. Add edge-cache layer to compensate**: aggressive Vercel edge cache for all read paths.
- **C. Defer**: acceptable while p95 < 1s and customer satisfaction is fine.

**Recommendation**: **C** today. Re-evaluate if p95 > 1.5s or merchants complain.

---

## Sequenced execution — when to do what

Reordered from v1 to align with risk tiers above.

| Session                        | Items                                                                                                                                  | Days   | Trigger to start                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| **2: Compliance core**         | #35 Cookies, #16 GDPR, #15 Data retention                                                                                              | 1-2    | NOW — top regulatory liability                           |
| **3: Observability**           | #12 Alerting (B: BetterUptime), #11 Log drain (A: BetterStack), #27 Cost alerts, #23 `/health/detail`, #33 Status page (free via #12B) | 1      | After session 2 — depends on having something to monitor |
| **4: Hardening + support ops** | #32 Governance (branch protection × 5 repos), #30 Crisp widget, #22 Test coverage to 70%                                               | 3      | After session 3                                          |
| **5: Staging environment**     | #19 Environments — Railway staging + Neon branch + Vercel preview env + E2E isolation                                                  | 3      | After session 4 — biggest architectural debt             |
| **6: Growth tooling**          | #34 Meta CAPI, #38 PostHog A/B (depends on #35), #37 Documentation site                                                                | 3-4    | Only if Wady Aljuz runs paid ads                         |
| **7: Scale prep** (deferred)   | #3 Platform billing, #26 Merchant churn alert, #8/#10 Multi-replica, #28 Multi-region                                                  | varies | Trigger on merchant #2                                   |

**Recommended next action**: start **session 2a (cookie consent banner)** in a focused plan-mode session — biggest user-facing regulatory risk + foundation for #38 PostHog later.

---

## Cross-project rollout

These tiers apply to every Force project. Stack-specific weighting:

| Project                        | Tier 1 priority                                                                    | Tier 2 priority                        | Notes                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| **Force Media CRM**            | #16 GDPR (PII-heavy client data, automations history), #35 Cookies (admin has GA?) | #22 Test coverage, #19 Staging         | No customer-facing storefront → cookie risk lower                     |
| **WhatsApp Bulk Sender (WBS)** | #16 GDPR (contact lists), #12 Alerting (per-tenant webhook URLs)                   | #22 Test coverage, #23 Instrumentation | Per-tenant WhatsApp credentials → secrets management is critical      |
| **Force Media Landing**        | #35 Cookies (marketing site = highest impact), #16 GDPR (lead form PII)            | #37 Documentation                      | Vanilla HTML stack = different fix shape but same compliance baseline |
| **New project (Mnasati ERP)**  | All 10 CLAUDE.md rules from day 1 — never retrofit                                 | n/a (no debt yet)                      | Bake the audit-passed posture in before first customer                |
