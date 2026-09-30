# MCP Merchant-Admin Surface — Design Spec

**Date:** 2026-09-11
**Status:** approved-in-principle by Ahmad ("build 1,2,3"), spec written before code.

## What Ahmad asked for

> "so mcp can be there to make people can change and control their settings and change
> and add products at mass and the mcp can do everything in the store like example the
> mcp is here now we can make it more powerful and can give pecanbee the abitly to use
> claude code or any other agent to change thier store settings get anayltics , remove
> or add any thing that support crud like they are using the admin dashboard exactly so
> they can login and use the mcp to do everything without using the web dashbaord"

The target user is a **merchant** (pecanbee), operating **their own store**, through
Claude Code or any MCP client, instead of the admin dashboard.

## What exists today

`POST /api/v1/mcp/:storeSlug` is a **buyer** surface: 7 tools, all shopper-facing
(`get_store_info`, `search_products`, `get_product`, `add_to_cart`, `view_cart`,
`place_order`, `get_order_status`). Reads are anonymous by design — that is the
strategic agentic-commerce surface. The two writes require a per-store `X-Agent-Key`
with the `agent:write` scope, checked inside the tool (never as middleware, because all
tools plus the protocol handshake ride one POST).

There is **zero** merchant CRUD.

## The central decision: a separate endpoint, not more tools on the buyer one

The buyer endpoint's defining property is that **reads are anonymous**. A merchant-admin
tool mounted on the same server would appear in that server's `tools/list` to every
anonymous caller — advertising the admin surface to the world, and making one
`assertAgentWrite` bug the difference between a shopper and a store owner.

So: **`POST /api/v1/mcp/admin/:storeSlug`**, a separate router, a separate
`buildMerchantMcpServer`, a separate credential, and — unlike the buyer endpoint —
**rejecting middleware is allowed**, because nothing on it is meant to be anonymous.
An unauthenticated caller gets the same 404 as an unknown slug, so the endpoint does
not confirm a store exists.

## Credential

A new `MerchantApiKey` model rather than a second column on `Store`:

```prisma
model MerchantApiKey {
  id           String    @id @default(uuid())
  storeId      String    @map("store_id")
  userId       String    @map("user_id")      // the human this key acts as
  name         String                          // "pecanbee laptop", shown in admin
  keyHash      String    @unique @map("key_hash")  // SHA-256 of the plaintext
  prefix       String    @map("prefix")        // first 8 chars, for display + lookup
  scopes       String[]                        // merchant:read, merchant:write, merchant:destructive
  lastUsedAt   DateTime? @map("last_used_at")
  expiresAt    DateTime? @map("expires_at")
  revokedAt    DateTime? @map("revoked_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  ...
}
```

Three departures from `Store.agentApiKey`, each deliberate:

1. **Hashed, not encrypted.** `agentApiKey` is AES-GCM encrypted because the buyer key
   is _displayed back_ to the merchant. An admin key is shown **once at creation** and
   never again, so a one-way hash is correct and removes the key from every read path —
   which is also what Ruling M5 (ciphertext riding out on wide reads) is about.
2. **Many per store, attributable to a user.** Revoking one laptop must not revoke the
   others, and every audit row must name a human.
3. **Scoped in three tiers.** `merchant:read` (analytics, list, get), `merchant:write`
   (create/update), `merchant:destructive` (delete, bulk overwrite, refund). A key
   minted for reporting cannot delete a product.

## Tool surface (15 tools, phase 1)

> **Status 2026-09-30:** the read tools shipped, plus five reads this table did
> not plan (`admin_list_customers`, `admin_get_customer`, `admin_get_funnel`,
> `admin_list_reviews`; `admin_list_coupons` below). The current, authoritative
> list is `docs/architecture/merchant-mcp.md`; write and destructive tools
> remain unbuilt.

Every tool is a **façade over the existing service layer** — no tool re-implements
business logic, so RLS, feature gates, validation and audit stay in one place.

| Tool                                         | Scope        | Delegates to        |
| -------------------------------------------- | ------------ | ------------------- |
| `admin_get_store`                            | read         | `store.service`     |
| `admin_update_store_settings`                | write        | `store.service`     |
| `admin_list_products`                        | read         | `product.service`   |
| `admin_get_product`                          | read         | `product.service`   |
| `admin_create_product`                       | write        | `product.service`   |
| `admin_update_product`                       | write        | `product.service`   |
| `admin_delete_product`                       | destructive  | `product.service`   |
| `admin_bulk_update_products`                 | destructive  | `bulk.service`      |
| `admin_set_inventory`                        | write        | `inventory.service` |
| `admin_list_orders`                          | read         | `order.service`     |
| `admin_get_order`                            | read         | `order.service`     |
| `admin_update_order_status`                  | write        | `order.service`     |
| `admin_get_analytics`                        | read         | `analytics.service` |
| `admin_list_coupons` / `admin_create_coupon` | read / write | `coupon.service`    |

**Refunds are deliberately excluded from phase 1.** They move money and have their own
idempotency and reversal machinery; they get their own slice with its own tests.

## Destructive operations: `confirm_token`

MCP's elicitation successor (MRTR) landed in spec `2026-07-28`, which **no published
TypeScript SDK supports** (1.29.0 and 1.30.0 both cap at `LATEST_PROTOCOL_VERSION =
2025-11-25`). So a destructive tool cannot ask the user mid-call.

Two-step instead:

1. Called without `confirm_token`, a destructive tool performs a **dry run**: it returns
   exactly what would change (counts, ids, before/after for the first 5 rows) plus a
   `confirm_token` — an HMAC over `{storeId, userId, tool, argsHash, exp}` with a 5-minute
   expiry, held in Redis single-use.
2. Called again with that token and **identical arguments**, it executes.

A changed argument changes `argsHash`, so the token does not validate — the agent
cannot preview a 3-row change and then commit a 3000-row one.

## Non-negotiables

- **Feature-gated**: `merchant_mcp`, in no plan baseline, so OFF for every store until a
  super-admin enables it. Same fail-closed 404 posture as `agent_checkout`.
- **Every write writes an audit row** via the existing `auditLog`, carrying the key id,
  the acting user, the tool, and the argument hash.
- **Tenant context is opened by the tool**, never by the router — the buyer endpoint's
  header comment explains exactly why (nested `$transaction` + external calls), and that
  reasoning applies unchanged.
- **Rate limited** separately from the public limiter; a merchant bulk job is not shopper
  traffic.
- **No new business logic.** If a tool needs behaviour a service does not expose, the
  service gets it, with its own tests, and the tool calls it.

## Rollout

Phase 1 (this plan): credential + endpoint + read tools + audit + tests.
Phase 2: write tools.
Phase 3: destructive tools + `confirm_token`.
Phase 4: admin UI for key management, `SKILL.md` skills, `/.well-known` discovery.

Shipping reads first means the surface is useful (analytics, catalogue inspection) and
provably safe before any tool can change a byte.
