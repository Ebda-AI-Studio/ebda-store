---
name: store-health-check
description: Use when the merchant asks how their store is doing, wants a weekly or monthly review, or says something like "what needs my attention" — produces a short prioritised report from live store data over MCP.
---

# Store health check

Produce a **short, prioritised** report a busy shop owner can act on in ten
minutes. Not a dashboard dump: a dashboard already exists, and repeating it
adds nothing.

## Gather

Call these, in this order, and stop as soon as you have enough to write the
report:

1. `admin_get_store` — confirm which store, and its currency.
2. `admin_get_analytics` — revenue, order count, average order value, top
   products, low stock. Pass `from`/`to` only if the merchant named a period;
   the service's default window is the right default.
3. `admin_list_orders` with `limit: 25` — the recent tail, to see what state
   orders are actually sitting in.

Do **not** page through the whole catalogue or the whole order history. If a
figure in the analytics payload looks wrong, say so rather than trying to
recompute it from a full listing — a disagreement between the two is itself
the finding.

## Money is in integer minor units

Every amount is an integer in the currency's **minor** units. KWD has three
decimal places: `12500` is **12.500 KWD**, not 125.00. Divide by 1000 for KWD,
100 for a two-decimal currency, and say which you used. Getting this wrong by
a factor of ten is the single most likely way this skill misleads someone.

## Report

Write at most one screen, in this order:

1. **One line on the period** — revenue, orders, AOV, each with the currency.
2. **What needs attention now** — at most five items, each a single line with
   the specific thing and the number behind it. Low stock on a top seller
   outranks low stock on a slow one. An order stuck unpaid for days outranks
   one from this morning.
3. **What is working** — at most three lines. A merchant who only ever reads
   problems stops reading.

Skip any section with nothing real in it. Do not invent a trend from a single
period; if you have one window of data, say so rather than describing a
direction you cannot see.

## Do not

- Do not recommend a price change from revenue data alone — you cannot see
  cost, margin, or why a price is what it is.
- Do not describe a product as failing on low order count; a new product and a
  dying one look identical in one window.
- Do not offer to fix anything. Every tool here is read-only, and offering a
  change you cannot make wastes the merchant's reply.
