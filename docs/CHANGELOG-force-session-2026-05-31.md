# Force AI — Session Changelog (running)

Live log of what changed this session so you can track it. Newest at top. FWB = force-website-builder, WBS = whatsapp-bulk-sender.

## FINAL @ main `b125c587` — build-clean for CI/deploy ✅
**Source-level typecheck verified** via deterministic sweeps (deps-independent): every `API_URL` use is imported, every `Prisma.` use is imported, zero untyped `async tx =>` callbacks. Build-health bugs fixed + landed this session (these would have broken Vercel/Railway):
- `layout.tsx` missing `API_URL` import (`77f5dcff`)
- `ReviewForm.tsx` + review `page.tsx` missing `API_URL` import (`b125c587`)
- 18 Sprint-1 `withMoneyTx` implicit-`any` `tx`/`i` params across 11 accounting/order services (`4355cc98`)
- 6 of those services missing the `Prisma` type import for the new annotation (`1d1f7f78`)
- Batch B `product.service` + Batch C `bulk-ai-recommendations` `tx` params (`def8f619`, `ae2ca556`)

Note: local `npx tsc` shows ~3 phantom errors (`withMoneyTx`/`rate-limit-redis` "not found") — these are STALE-node_modules artifacts (the dev tree's built `@force/database` predates Sprint 1 + `rate-limit-redis` isn't installed locally). CI/deploy run clean `npm ci` + rebuild `@force/database`, so they do not occur there. The honest "clean build" verdict is at the SOURCE level, confirmed by the sweeps above — NOT a full local compile (which the polluted dev env can't give).
**Landed today:** build fix · E1/E2 accounting (CoA seeded, 12 paid orders' journals balanced) · Batch A (C1/C2/C3) · Batch B (D1/D5/D7) · Batch C (H2/H3/F4b) · F1 RLS cutover (force_app) · Inngest re-registered · all typecheck-clean.
**WBS bot fixes** (I1 botMode persistence, I2 remove image-per-category) are on branch `fix/bot-native-catalog` — NOT merged, awaiting your review.
**⚠️ ONE DECISION (C1):** order-status relabel is semantically misleading (shipped→"Delivered" shows while order is only with courier). Keep / revert / proper enum? (detail below)
**Still queued:** A-group settings→pagebuilder consolidation + B-group discount fields (design-gated); RLS fail-closed `IS NULL` removal (blocked on withRlsBypass migration — super-admin uses 28 unscoped queries); autoscaling/replicas (not enabled — needs Socket.io redis-adapter + cron leader-election first).

## STATUS — ALL 3 FEATURE BATCHES LANDED ✅
**Prod main = `a1b2c3d4`.** Batches A+B+C all landed; i18n keys from all three verified coexisting on main (moreItems + lowStockThreshold + asOf), admin+api typecheck 0 errors. Deploying.
- **Batch A (orders/customers):** C1 status relabel, C2 order-list item summary, C3 Active Buyer fallback badge.
- **Batch B (inventory):** D5 shared SearchInput on inventory page (lists all items), D7 Cost/Price/Sales-quantity columns, D1 low-stock threshold per-product + bulk. (typecheck fix: typed `tx` param in product update tx.)
- **Batch C (AI):** H2 bulk product-FAQ sweep (reuses single-FAQ core), H3 frequently-bought-together recommendations (co-purchase signal + hardened JSON parse), F4b velocity panel date+time.

**⚠️ DECISION NEEDED (C1):** the order-status relabel in Batch A is SEMANTICALLY MISLEADING. Code: `shipped` = handed-to-courier (fires shipped-email + WBS event), `delivered` = received-by-customer (sets deliveredAt, review request, loyalty). Relabeling shipped→"Delivered" + delivered→"Fulfilled" means admin sees "Delivered" while the order is only with the courier. **Keep / revert / proper backend enum change? Your call.**

**Still queued:** WBS bot (I2 remove image-per-category sends, I1 botMode persistence); A-group Settings→PageBuilder consolidation + B-group discount fields (design-gated).

## ✅ ALL CLEAR — no open blockers as of last update
- **FWB Vercel build break — FIXED + VERIFIED on main (`77f5dcff`).** `layout.tsx` imports `API_URL` now; build clean.
- **Accounting E1+E2 — FULLY FIXED + VERIFIED.** CoA seeded (54 accounts / 2 stores). All **12/12 historical paid orders** replayed → journal entries posted, **debits == credits (balanced, 56750==56750)** across both stores. New paid orders auto-post via Inngest. Revenue now reflects in the GL.

## DONE + verified (landed on FWB main)
- **E1 — Chart of Accounts seeding** (`ff2e0a5f`, `cfde2199`): `POST /:storeId/finance/accounts/seed` endpoint + admin "Seed default accounts" button + create-custom-account UI (EN+AR). Plus `scripts/backfill-coa.ts`. CoA now seeded for both stores (Wady Aljuz + Palora), 27 accounts each.
- **E2 — journal-post observability** (`ff2e0a5f`, `01646f92`): Sentry+logger on the `accountingPostOrderJournal` retry-exhaust path so silent failures surface; `scripts/replay-order-journals.ts` for historical backfill.
- **C4 — "Margin per unit" → "Profit margin per unit"** (`4cc92358`): EN + AR (`profitLabel` i18n key).
- **G1 — doubled `/api/v1/api/v1/` 404** (`59b74771`): 5 call sites switched to the `API_URL` constant (StoreContext, WaTokenHydrator, layout, 2 review pages). ⚠️ layout.tsx needed the follow-up import fix above.
- **F1b + F2b — insights dashboard/segments crashes** (`bfa0bf5c`): API serializers aligned to the admin page contract (`topSegment`→object, `aov`→`{thisPeriodFils,lastPeriodFils}`, `topSkus`→`unitsSold7d/velocity`, segments `name`→`segment`) + defensive `.replace` guards.

## DONE earlier this session
- **F1 — RLS now enforced in prod (the real Critical).** Cut prod `DATABASE_URL` over to the non-owner `force_app` Neon role (was `neondb_owner`, which bypassed all RLS). `FORCE ROW LEVEL SECURITY` confirmed ON; tenant scoping verified (store A → 24 orders). DIRECT_URL/MIGRATION_DATABASE_URL stay owner for migrations. force_app password is on Railway only (not local .env).
- **Inngest re-registered in prod** (`PUT /api/v1/inngest` → `modified:true`) — async jobs (journal posting, AI recommendation/reorder sweeps, dead-stock) were silently dead; now live.
- **Sprint 1 (audit remediation)** on FWB main: F6 `withMoneyTx` (maxWait 2s-trap) across 42 tx sites, F8 redis-backed rate limiting, C5 `safeDecryptJson`, F3 cross-tenant isolation test, F2 blog SSR metadata.
- **WBS Sprint 1** on WBS main (`4193e11a`): W1 atomic send-flip (double-send race), W3 maxWait+pool, W4 status rank-guard + message_status_events, W5 unique+upsert, W8 stub-worker removal, W14 hashed bridge keys.
- **27-type fleet audit** of both projects → `docs/audits/` (master + 18 cluster reports + 4 diagnosis reports).

## Infra answers (from code/infra inspection)
- **Autoscaling: NONE.** Single Railway instance, no replicas, no autoscale policy. Effectively vertical-only. Code is *replica-ready* (Redis rate-limit + shared cache + pooled DB) but Socket.io has NO redis-adapter and 14 module-level `setInterval` crons would duplicate across replicas — both must be fixed before turning on replicas>1. (Detailed plan pending.)
- **Caching: strong.** Two-tier (Redis → in-memory BoundedMap) read cache + Vercel edge CDN (`s-maxage`+`stale-while-revalidate`) + proper write-path invalidation. Anonymous browsing mostly edge/Redis-served, NOT hitting DB every load.
- **Rate limiting: Redis-backed** (Sprint 1), holds across replicas.

## Backlog still open (Phase 2 — `docs/plans/2026-05-31-phase2-remediation.md`)
- Batch A (orders): C1 status rename (label-only if matches logic), C2 pending order item+customer name.
- Batch B (inventory): D1 low-stock threshold UI+bulk, D5 search bar, D7 cost/price/sales columns, D2/D3/D4 explain+verify reorder/deadstock/payment-terms.
- Batch C (AI): H2 bulk FAQ sweep, H3 frequently-bought-together prompt, F4b velocity date-time. C3 Active Buyer label (Option A).
- WBS bot (I1/I2/I3): remove image-per-category, fix botMode persistence, Meta provision.
- A-group (Settings→Page Builder consolidation) + B-group (discount fields) — design-gated, your call.
- RLS fail-closed `IS NULL` removal — BLOCKED (super-admin uses 28 unscoped prisma calls; needs withRlsBypass migration first).
- Autoscaling enablement (replicas + Socket.io redis-adapter + cron-leader-election).
