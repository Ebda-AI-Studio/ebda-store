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

`admin_get_store` · `admin_list_products` · `admin_get_product` ·
`admin_list_orders` · `admin_get_order` · `admin_get_analytics`

Every one is a thin façade over the **same service method the dashboard calls**.
No tool re-implements a query or a permission check, so RLS, feature gates and
validation stay defined once. `admin_list_products` sees draft and archived
products; the buyer surface never does.

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
