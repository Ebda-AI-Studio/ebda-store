# MCP-R2

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling MCP-R2 — contact details are always masked on the MCP surface; there is no `includeContact`
opt-in.** The audit suggested an opt-in flag; every key today carries only `merchant:read`, so a
flag would unmask for every key and the masking would be decorative. Applied to the existing
`admin_get_order` / `admin_list_orders` as well — they previously returned full addresses and
emails, the same PII the customer tools mask. Cost if wrong: an agent drafting a courier hand-off
cannot read the street address or phone and the merchant copies it from the dashboard. Issue 2244
extends it to shopper free text: `admin_get_order` is an allowlist and its `notes`/`customerNotes`
pass through `redactFreeText` (phone-shaped 8+ digit runs — not ISO dates or order references — and emails replaced). Cost if wrong: a
note whose meaning IS a free-standing number of 8+ digits (a gift-card code typed into the note)
reads as `[phone]`, and the merchant reads it on the dashboard.
