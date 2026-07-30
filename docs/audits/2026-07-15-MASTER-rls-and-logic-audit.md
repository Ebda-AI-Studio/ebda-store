# MASTER Audit — RLS + Project Logic, All Layers (2026-07-15)

Consolidates five parallel read-only audits triggered by a production 500 on
`PUT /stores/:id/orders/:id/status` (P2028 transaction timeout). Deduped and
prioritized. Component reports:

- `2026-07-15-rls-transaction-timeout-class.md` (E — 5C/8H/5M/4L)
- `2026-07-15-money-integrity-audit.md` (C — 3C/2H/2M/1)
- `2026-07-15-api-tenant-scoping-idor-audit.md` (B — 3C/2H/2M/6L)
- `2026-07-15-rls-enforcement-audit.md` (A — 0C/5H/4M/6L)
- `2026-07-15-frontend-trust-boundary-audit.md` (D — 1C/0H/2M)

## The linchpin fact (elevates everything)

**Production runs as a `BYPASSRLS` database role** (audit A, prior-audit F1, still
open). Therefore **RLS is NOT currently the tenant-isolation safety net** — the
Express authz layer (`authorize` + `requireStoreAccess` + `requirePermission`) is
the _only_ line of defense. Every app-layer IDOR below is **live-exploitable
today**, not merely degraded defense-in-depth. Completing the `force_app` cutover
(prod runs as a non-bypass role) is the single highest-leverage fix — it backstops
several IDORs at once — but does NOT cover tables/surfaces with no `storeId` column
or no tenant-context wiring (C1, C3, H1 below).

## Consolidated Criticals (fix first)

### CRIT-1 — Refund leaves durable, unrepairable money-loss state (C + E)

The reported 500's real danger. Request path wraps everything in one 30s tx, but
`applyRefundEffects`'s inner `withMoneyTx` commits on a SEPARATE connection (the
ALS proxy in `packages/database/src/index.ts` doesn't route `$transaction`). On a
refund/cancel with enough items+affiliate+loyalty+backorder work, the 30s wall is
hit → P2028. `Order.status`/`Payment.status` already flipped to `refunded` in an
earlier separate commit that survives; the reversals (inventory/coupon/affiliate/
loyalty/backorder) do not run. **All three retry paths are structurally blocked**
(terminal state; webhook `wasAlreadyHandled`; refresh-status precondition). Net:
order shows "refunded" forever while commission stays owed, coupon usage inflated,
loyalty unreversed, backorders open. Also: admin "refund via provider" **swallows
the error and returns HTTP 200** (operator gets no signal); the coupon marker is
written BEFORE its effect (retry skips it permanently). Reachable from **4 routes**,
3 of which make a payment-gateway HTTP call before the loop.
_Fix:_ each reversal atomically idempotent (marker WITH effect, same tx); move the
reversal set to the `order/refunded` Inngest fanout as retriable dead-lettering
steps (proven #528 pattern); request handler = update status + fire event + return
fast; stop swallowing the provider-refund error; enforce the state machine on ALL
status writers.

### CRIT-2 — Five live cross-tenant IDORs (B) — prod is BYPASSRLS so all exploitable now

- **Product FAQ CRUD** (`product.routes.ts:830/848/874/903`) — scoped only by
  `productId`, never `storeId`; `ProductFaq` has NO `storeId` column so RLS can
  never backstop it. Any store_admin/staff reads/writes/deletes any store's FAQs.
- **Smart-layer accept/clearance** (`smart-layer.routes.ts:92/184` →
  `purchase-order.service.ts:328`, `deadstock-scan.service.ts:364`) — unscoped
  `findUnique({where:{id}})` then writes with the resource's own storeId → create a
  real PO / clearance coupon in another store. (Backstopped post-cutover.)
- **WA-bridge meta-catalog-config POST** (`wa-bridge.routes.ts:1111`) — trusts body
  `storeId` in `store.update`; overwrite another store's Meta catalog credentials.
- **WA-bridge customer-addresses** (`:1150/1169`) — `where:{customerId}` only →
  cross-tenant delivery-address PII read/write. (H, but cross-tenant.)
- **Order refunds missing `requirePermission('orders:refund')`**
  (`order.routes.ts:1178/1003`) — `staff` (deliberately excluded from refunds) can
  trigger provider refunds / flip Payment.status. (Same-tenant priv-esc.)
  _Root shape:_ trusting a client `storeId`/`customerId` or an unscoped `:id` instead
  of the authenticated tenant key. The WA-bridge surface (`waBridgeAuth`) was never
  wired to tenant-context, so it has no RLS backstop at all.
  _Fix:_ scope every lookup by the authenticated tenant (path `:storeId` via
  requireStoreAccess, or `req.bridgeStore.id`); add `orders:refund` permission; add a
  `storeId` column + policy to `ProductFaq`.

### CRIT-3 — Open redirect in login `returnTo` (D) — regression from today's #741

`postLoginDestination()` (admin `auth.tsx:185`, shipped today) + storefront
`LoginClient.tsx:45` (pre-existing) validate with `startsWith('/') && !startsWith('//')`,
which a leading backslash defeats: `/\evil.com` → `https://evil.com/` on
`router.push`. VERIFIED live. Storefront custom-domain traffic (the main pattern)
is affected.
_Fix:_ validate with real URL parsing — `new URL(candidate, origin).origin === origin`
and reject `/login` — not string prefixes. One shared helper for both apps.

## High (fix next)

- **tx-timeout siblings (E):** `VariantService.generateVariants` (unbounded
  sequential creates), WA-template `POST /sync` (60s fetch inside 30s tx),
  `payment-links POST /` (28s external inside tx), the 3 other `applyRefundEffects`
  routes with pre-loop gateway HTTP, 9 synchronous Gemini+Redis `ai.routes.ts`
  endpoints with no SDK timeout guard, staff creation (5 nested tx), XLSX exports.
- **payment-settings has zero RLS wiring (A)** — `PaymentConfig` (encrypted provider
  secrets) mounted at a bare prefix, no router/callsite tenant context. Add it.
- **Affiliate fire-and-forget race (A, `order.service.ts:730`)** — referral link
  write races the request tx commit → silent dropped commission, no reconciliation.
- **Money state machine only enforced on admin route (C)** — 3 webhook/gateway
  sites write `Order.status` directly with no transition check → stale-webhook
  regression.
- **Webhook `withRlsBypass(_tx => …)` no-op + missing `@@unique` on transactionId/
  invoiceId (A)** — latent cross-tenant/double-process risk.

## Medium / Low

Policy typo `product_daily_views` `bypass_rls='on'` vs code `'true'` → view tracking
silently breaks at cutover (A); `X-Store-ID` client-controlled wishlist tag (D, data
nuisance); `apiGet<T>()` unchecked cast across ~49 sites (D); WA-bridge config GET
disclosure via query storeId (B); order mark-paid missing permission (B); assorted
Low in each report.

## Systemic root causes (three, not fifteen)

1. **Prod on BYPASSRLS** → app-layer authz is the only isolation → every authz gap
   is live. Finish the `force_app` cutover.
2. **The outer request transaction is never budgeted** — the ALS proxy makes
   nested `$transaction`s a separate connection, so "nothing slow in the tx" was
   applied to inner txns but never the always-present outer one. Heavy/looped/I-O
   work in a handler eats the 30s.
3. **Idempotency markers written before (not with) their effect**, and **effects
   split across separate-connection transactions** → partial-commit money drift.

## Recommended fix sequence

1. CRIT-3 open redirect (tiny, isolated, my regression) — ship immediately.
2. CRIT-2 the 5 IDORs (security, live-exploitable) — one PR, scope-by-auth-tenant.
3. CRIT-1 refund money-path redesign (needs a written plan + TDD — money code).
4. High batch (tx-timeout siblings + payment-settings RLS + affiliate race + state
   machine + webhook unique).
5. Strategic: complete the `force_app` non-bypass cutover (backstops class 1).
