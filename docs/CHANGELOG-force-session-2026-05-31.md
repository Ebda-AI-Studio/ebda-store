# Force AI — Session Changelog (running)

Live log of what changed this session so you can track it. Newest at top. FWB = force-website-builder, WBS = whatsapp-bulk-sender.

## STATUS @ last update (tool channel was unstable — verify before trusting)
**Prod main = `77e5e369`** (build fix + E1/E2 accounting + Batch A orders/customers). All LANDED + deploying.
**NOT yet landed (safe on branches, ready):** `fix/batch-b-inventory` (D1/D5/D7), `fix/batch-c-ai` (H2/H3/F4b). Both conflict with main ONLY on the 2 i18n JSON files (additive keys). My automated deep-merge dropped keys on one attempt — DO NOT trust it; redo the B/C i18n merge as a careful key-union and verify A's keys (orders.list.table.moreItems, customers.page.badges) + B/C's keys all survive before pushing.
**⚠️ DECISION NEEDED (C1):** the order-status relabel I shipped in Batch A is SEMANTICALLY MISLEADING. Code: `shipped` = handed-to-courier (fires shipped-email + WBS event), `delivered` = received-by-customer (sets deliveredAt, review request, loyalty). Relabeling shipped→"Delivered" + delivered→"Fulfilled" means the admin now sees "Delivered" while the order is only with the courier. Keep / revert / or do a proper backend enum change? Your call.

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
