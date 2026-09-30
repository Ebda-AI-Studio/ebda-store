# Merchant-admin MCP surface

`POST /api/v1/mcp/admin/:storeSlug`

Lets a merchant run their own store from Claude Code — or any MCP client —
instead of the admin dashboard. Distinct from the **buyer** surface at
`POST /api/v1/mcp/:storeSlug`, which exists so shopping agents can browse and
order anonymously.

## Why two endpoints and not more tools on one

The buyer surface's defining property is that **its reads are anonymous**. Its
`tools/list` therefore answers anyone. An admin tool registered there would be
advertised to the world, and one bug in a per-tool auth check would be the only
thing between a shopper and a store owner.

That constraint also forces the buyer router to do auth _inside_ its write
tools: all tools plus `initialize` and `tools/list` ride one POST, so a
rejecting middleware would take the whole agentic-commerce surface dark.

Nothing on the merchant surface is meant to be anonymous, which inverts it.
`mcp-admin.routes.ts` **rejects before the MCP server is built**, so an
unauthenticated caller never receives a tool list.

## Credential

`MerchantApiKey` — one row per device, not one per store.

|               | `Store.agentApiKey` (buyer) | `MerchantApiKey` (admin)                    |
| ------------- | --------------------------- | ------------------------------------------- |
| Storage       | AES-256-GCM encrypted       | SHA-256 **hash**                            |
| Recoverable   | yes, shown in admin         | **no** — shown once at mint                 |
| Count         | one per store               | many, one per device                        |
| Attributed to | the store                   | a **user**                                  |
| Scopes        | `agent:write`               | `merchant:read` / `:write` / `:destructive` |

Hashed rather than encrypted because it is never displayed again — which also
keeps the secret off every read path, the concern Ruling M5 raised about
credential ciphertext riding out on wide `Store` reads.

**The user binding is enforced, not just recorded.** `verifyMerchantKey` reads
the owning `User` on every call and refuses a suspended or soft-deleted one,
and `AuthService.revokeAllSessions` revokes that user's merchant keys as well
as their refresh tokens. Two independent checks, because "sign out all devices"
has to mean all devices — a long-lived credential acting as a person must die
when the person's access does.

Header: `x-merchant-key`. Prefix `fwbm_` so a leaked key is greppable and
self-identifying.

### Managing keys

```
GET    /api/v1/stores/:id/integrations/merchant-keys       # metadata only
POST   /api/v1/stores/:id/integrations/merchant-keys       # plaintext ONCE
DELETE /api/v1/stores/:id/integrations/merchant-keys/:keyId
```

Requires `store_admin`/`super_admin`, MFA, store access, and the `merchant_mcp`
feature. A key minted without an explicit `scopes` array defaults to
**read-only** — an unspecified scope must be the least dangerous thing it
could be. Cap of 20 active keys per store (housekeeping, not a boundary).

## Feature gate

`merchant_mcp`, in **no plan baseline** — OFF for every store until a
super-admin enables it, and the endpoint 404s while off. Correct default for a
surface that can change anything in a store.

## Refusals are indistinguishable

Unknown slug, feature disabled, and missing/unknown/revoked/expired/cross-store
key all produce a byte-identical `404 NOT_FOUND`. A prober cannot map which
stores have the feature, nor which keys are real. Do not give any of these path
a distinct code or message — there is a test asserting all three bodies are one.

## Tools (phase 1 — read only)

| Tool                                        | Returns                                                                | Delegates to                 |
| ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| `admin_get_store`                           | name, currency, domain                                                 | resolved store               |
| `admin_list_products` / `admin_get_product` | incl. draft/archived, variant-aware stock                              | `ProductService`             |
| `admin_list_orders` / `admin_get_order`     | totals, status, **delivery detail**, status history (get)              | `OrderService`               |
| `admin_get_analytics`                       | dashboard stats, top products, low stock                               | `AnalyticsService`           |
| `admin_list_coupons`                        | code, type, value, usage vs limit, active dates, derived state         | `CouponService.list`         |
| `admin_list_customers`                      | Customers-page rows: order count, total spent, last order, RFM segment | `customer-aggregate.service` |
| `admin_get_customer`                        | one customer's totals, segment, order history                          | `customer-aggregate.service` |
| `admin_get_funnel`                          | views → carts → orders over 7/30/90 days, step rates, daily rows       | `funnel-report.service`      |
| `admin_list_reviews`                        | rating, text, product, status, merchant reply, date                    | `ReviewService.listForStore` |

Every one is a thin façade over the **same service method the dashboard calls**.
No tool re-implements a query or a permission check, so RLS, feature gates and
validation stay defined once. `admin_list_products` sees draft and archived
products; the buyer surface never does. Every list tool takes `page` + `limit`
(Zod-bounded) and returns its total. Registrars: `tools/admin-read.tools.ts`
and `tools/admin-read-customers-marketing.tools.ts`.

### Contact details are masked

Tool output lands in a third-party LLM's context and transcript, so every
customer contact leaves masked — email `a***@gmail.com`, phone
`+965 ****1234` (`lib/pii-mask.ts`) — and no street-level address is
returned (`maskAddress` keeps name, area, governorate, city, country). This
applies to customers, reviewers, and the order tools (`admin_get_order`'s
shipping/billing address and customer email; a nameless customer's
`customerName` in `admin_list_orders`). There is **no unmask flag**: the
merchant has the full record on the dashboard (Ruling MCP-R2).

### Customers: the same rows as the Customers page

`admin_list_customers` groups exactly like the admin Customers page — a
registered shopper by user id, a guest checkout by lowercased email, else
phone (`lib/customer-key.ts` `customerKeyOf`) — so guests count. A guest's
Customers-page id IS their email or phone, so tools use an opaque
**`customerRef`** instead: the user id for a registered customer, and
`GUEST:<sha256>` for a guest — the same key its RFM snapshot is stored under,
so an agent can correlate a customer with their segment without seeing the
contact. `admin_get_customer` resolves a ref only against this store's rows;
an unknown or foreign ref is a tool error. A guest checkout with no email and
no phone is listed (ref `guest:<orderId>`) but has no profile — its one order
is readable through `admin_get_order`.

### Funnel: unknown is `null`, never 0 (owner ruling AUD-2)

`admin_get_funnel` reports `checkoutsStarted` and `ordersAbandoned` as `null`
with a reason in `unavailable`: both are derived from `abandoned_carts`, which
guest carts never produce, so a 0 would falsely say "nobody did this". With no
rollup rows for the window every stage is `null` and `daysCovered` is 0.

### Delivery detail

`admin_list_orders` rows and `admin_get_order` carry a `delivery` block with
only what the platform records: `method` (carrier of a booked shipment, else
`null`), `shipmentStatus`, `trackingNumber`, `estimatedDeliveryAt`,
`governorate`, `area` (the zone the shipping fee matched on — the zone row
itself is not stored on the order), `city`, `country`, `shippingFee`, and the
`placedAt` / `shippedAt` / `deliveredAt` timestamps. `slot` is always `null`:
checkout does not capture a delivery slot. `admin_get_order` adds
`statusHistory` from the append-only `order_events` trail.

### Not exposed: payouts / settlements

There is no settlement data to expose: no gateway-settlement model exists
(only `affiliate_payouts` and per-order `payments`). A tool that presented
`payments` as payouts would be inventing a concept; a real settlement tool
needs a MyFatoorah/Tap settlement import first (Ruling MCP-R3).

`admin_get_analytics` returns `AnalyticsService.getDashboardStats` verbatim, so
its semantics are the dashboard's (2026-09-30): customers are counted with the
Customers page's key (registered user → shipping email → phone, guests
included — `lib/customer-key.ts`); `totalProfit` is `null` when sold lines have
no cost price and `profitItemsMissingCost` says how many lines a partial figure
excludes; `conversionRate` is orders per product view (%) from
`funnel_snapshots`, or `null` when no views were recorded — never a fabricated 0.

Phases 2 and 3 (writes, then destructive ops with a `confirm_token` two-step)
land as separate registrars — see
`docs/superpowers/specs/2026-09-11-mcp-merchant-admin-design.md`.

## Tenant context

Opened by each tool via `runInTenantContext`, never on the router — for the two
reasons `mcp.routes.ts` documents, the second of which is decisive here:
`tenantContext` reads `req.params.storeId || req.params.id`, and this router's
param is `:storeSlug`, so mounting it would be a silent no-op that merely looks
like protection.

## Client configuration

```json
{
  "mcpServers": {
    "my-store": {
      "type": "http",
      "url": "https://api.force-ai.co/api/v1/mcp/admin/<store-slug>",
      "headers": { "x-merchant-key": "fwbm_..." }
    }
  }
}
```
