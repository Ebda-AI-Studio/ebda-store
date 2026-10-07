# Agent skills for Ebda merchants

Portable `SKILL.md` packages a merchant can drop into Claude Code — or any
agent client that reads the skill format — to run a real store task against
their own store over MCP.

## Why these live here and not in the product

A skill is a prompt with a procedure, not code. It does not need to be
deployed, versioned with the API, or gated. Keeping them in the repo means
they sit next to the tools they call, so a tool rename breaks a grep here
rather than breaking a merchant's Monday.

## Setup (once per store)

1. In the admin dashboard: **Settings → Merchant MCP keys → Issue key.**
   Read-only is enough for every skill in this directory — none of them writes.
2. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "my-store": {
      "type": "http",
      "url": "https://api.ebda.app/api/v1/mcp/admin/<store-slug>",
      "headers": { "x-merchant-key": "ebdam_..." }
    }
  }
}
```

3. Copy the skill directory into your client's skills folder.

## The rule these skills follow

**Every tool named in a skill exists today.** There is no `admin_refund_order`
skill in this directory, because there is no refund tool yet — a skill that
names a tool the server does not expose fails on first use and reads as a
broken product rather than a missing feature. When phase 2 (writes) and phase 3
(destructive) land, the skills that need them land with them.

Current tools: `admin_get_store`, `admin_list_products`, `admin_get_product`,
`admin_list_orders`, `admin_get_order`, `admin_get_analytics`,
`admin_list_coupons`, `admin_list_customers`, `admin_get_customer`,
`admin_get_funnel`, `admin_list_reviews` — all read-only. Customer contact
details come back masked (see `docs/architecture/merchant-mcp.md`).
