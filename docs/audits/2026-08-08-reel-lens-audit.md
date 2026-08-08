# Audit — the 5 new foundation lenses (21–25) against FWB · 2026-08-08

Rubric: `force-ai-foundation/standard/{migration-safety,error-surface,ai-transparency,edge-protection,unit-economics}.md`
(added in foundation PR #85, derived from a fleet of 8 builder-failure-mode reels).

Every FAIL below was confirmed against the live system or the live database — none are inferred from architecture notes.

## Verdict per lens

| Lens                  | Grade           | Headline                                              |
| --------------------- | --------------- | ----------------------------------------------------- |
| 21 `migration-safety` | **1 — partial** | Strong practice, one real miss already fixed today    |
| 22 `error-surface`    | **2 — solid**   | Two-layer split is real; boundary coverage unverified |
| 23 `ai-transparency`  | **0 — absent**  | No disclosure, no consent gate, no generation log     |
| 24 `edge-protection`  | **1 — partial** | Storefront protected; **API origin is not**           |
| 25 `unit-economics`   | **1 — partial** | Attribution exists; the ratio does not                |

## P1 — the API origin bypasses the edge (24.1, 24.2)

```
$ curl -sI https://api-production-c058.up.railway.app/health
server: railway-hikari                 <- no cf-ray, no edge

$ curl -sI https://store.force-ai.co
server: cloudflare
cf-ray: a280ceba9f00d60a-KWI           <- protected
```

The storefront, admin and orders apps are Cloudflare Workers and sit behind the edge. **The Express API does not.** It answers directly from Railway — and that is the origin holding authentication, the payment webhook receivers, and every AI generation endpoint.

Consequence: the WAF, bot rules and volumetric absorption apply to the half that is mostly cached static content, and not at all to the half that is expensive, stateful and security-sensitive. Application-layer rate limiting still requires the request to reach Express.

**Fix:** front `api.force-ai.co` with Cloudflare (proxied DNS), then restrict the Railway origin to Cloudflare IPs or an authenticated origin pull so the `*.up.railway.app` hostname stops serving public traffic. Add tighter caps on the AI generation endpoints specifically (see lens 25 — those are a direct debit from margin, not just an availability risk).

## P1 — no AI transparency surface at all (23.1, 23.4, 23.6)

FWB generates merchant-facing and **customer-facing** content with Gemini: product descriptions, SEO copy, EN/AR translations, product FAQs, AEO/GEO answers.

- **23.1 / 23.6 FAIL** — no disclosure string exists anywhere in `apps/web/src` or `packages/shared/src`. AI-generated copy renders on public storefronts unlabelled. The obligation lands at _render_, and generation happens in admin, so nothing in the admin UI would satisfy it.
- **23.4 FAIL** — `AiUsage` records `storeId`, `feature`, `inputTokens`, `outputTokens`. There is no prompt, no model name, no output reference. **There is no generation log**, and unlike labelling it cannot be reconstructed retroactively.
- **23.3 UNKNOWN** — a consent-gate pattern exists in the codebase; whether it gates _AI processing of user input_ specifically was not verified here.

EU AI Act transparency obligations have been enforceable since 2026-08-02, and reach follows the **user's** location, not the merchant's. Kuwait-only merchants are lower risk, but "we only sell locally" is a claim, not a control.

**Fix, in order:** (1) add model + prompt + output-ref columns to the generation path — the part that cannot be backfilled; (2) render a disclosure on AI-generated storefront copy, i18n'd EN/AR incl. RTL; (3) confirm the consent gate covers AI input processing.

## P2 — unit economics: instrumented, not measured (25.3, 25.4)

`AiUsage` already carries `storeId` **and** `feature`, plus daily/monthly caps via `lib/ai-quota.ts`. So:

- **25.1 PASS** (per feature) · **25.2 PASS** (per tenant) · **25.6 PASS** (caps enforced)
- **25.3 FAIL** — zero cost/currency columns. Spend is measured in tokens, never money.
- **25.4 FAIL** — nothing joins AI spend to what a merchant pays. The only aggregate (`ai.service.ts:139`) is for quota enforcement, not margin.
- **25.7 / 25.8 FAIL** — no margin view, no alert.

This is the exact "instrumented ≠ measured" case the lens was written for, and it bites hardest on a **managed-agency model**: Force AI absorbs the Gemini and infra cost on the merchant's behalf, so there is no invoice signal per merchant at all. A heavy merchant costs more without anything surfacing it.

**Fix:** a per-model rate table → cost on each `AiUsage` row at write time (attribution cannot be reconstructed later), then a per-store monthly view of spend vs plan price, then an alert when spend crosses a share of revenue.

## Lens 21 — migration safety: 1, with today's miss already closed

Strong existing practice: additive-only migrations, documented lock notes, `IF NOT EXISTS` throughout, `CONCURRENTLY` escape hatches, PITR + local pg_dump + R2 copies.

The gap the lens exists to catch fired today. `products` had a declared-but-never-created `@@unique([storeId, sku])`. The pre-check filtered `deleted_at IS NULL` → 0 duplicates → "safe to add". Prisma's plain unique index has **no WHERE clause** and covers soft-deleted rows, where a real duplicate existed (a merchant soft-deleted a product and recreated it in English reusing SKU `S-0015`). Since FWB applies migrations on API boot, that would have been an outage.

Shipped as a **partial** unique index (`WHERE deleted_at IS NULL`) — which is also the correct rule, since blocking SKU reuse after deletion would be a product regression. It also exposed a live bug: four lookups in `stock-adjustments.routes.ts` matched by SKU/barcode with no `deletedAt` filter and could apply stock adjustments to a soft-deleted product, non-deterministically.

Remaining for a grade of 2: **21.3** — there is no current staging mirror of production; migrations are tested against CI's ephemeral Postgres with synthetic data, not real data shapes.

## Lens 22 — error surface: 2

`middleware/error-handler.ts` returns `{ success:false, error:{ code, message } }` and nothing else. No stack, no driver text, no SQL reaches a response — the one `error.stack` reference in `apps/api/src/index.ts:606` goes to an alert payload, not to a client. Log level is chosen by error class rather than blanket-`error`. Sentry + pino behind it.

Not verified here, and the criterion most likely to rot (22.4): whether **all** 57 Inngest functions, 4 webhook receivers and the cron sweeps are individually wrapped. The lens says to audit by enumerating entry points rather than reading the middleware — that enumeration is the follow-up.

## Ranked next actions

1. **P1** Put Cloudflare in front of the API origin; lock Railway to edge-only (24.1, 24.2).
2. **P1** Add model/prompt/output columns to the AI generation path — the un-backfillable half of 23.4.
3. **P1** Render an AI disclosure on storefront-rendered generated copy (23.1, 23.6).
4. **P2** Cost-per-row on `AiUsage` + per-store spend-vs-revenue view (25.3, 25.4).
5. **P2** Enumerate all 57 Inngest fns + 4 webhook receivers for error wrapping (22.4).
6. **P3** Stand up a staging mirror with production-shaped data (21.3).
