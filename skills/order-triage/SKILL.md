---
name: order-triage
description: Use when the merchant asks what orders need action, which orders are stuck, whether anything has gone wrong today, or wants a fulfilment to-do list.
---

# Order triage

Answer one question: **what should the merchant do next?**

## Gather

1. `admin_list_orders` with `limit: 50`. Add `from`/`to` only if the merchant
   named a period. Sorted newest first.
2. `admin_get_order` on the ones you are going to flag — only those. The list
   payload carries each order's `delivery` block (carrier, area, shipped /
   delivered timestamps) but no line items, street addresses, or payment
   records; `admin_get_order` adds those plus the status history. Contact
   details are masked in both.

## What counts as stuck

Judge from `status` and `paymentStatus` together — neither alone is enough:

- **Paid and not yet processing.** The customer has paid and nothing has
  happened. This is the top of the list, always.
- **Unpaid for more than a day, online payment.** Either abandoned or a failed
  gateway hand-back. Worth one look, not a chase.
- **Unpaid and COD.** NOT stuck. Cash on delivery is unpaid by definition until
  the driver hands it over — flagging these as problems is the most common way
  to make this report useless.
- **Processing for several days.** Fulfilment has stalled.
- **Cancelled or refunded with an unusual total.** Worth naming, not acting on.

## Money is in integer minor units

`total` is an integer in the currency's **minor** units. KWD has three decimal
places: `30000` is **30.000 KWD**. Divide by 1000 for KWD, 100 for a
two-decimal currency, and say which you used.

## Report

A list, most urgent first. Each line: order number, what state it is in, how
long it has been there, and the one action. Nothing else.

If nothing is stuck, say exactly that in one line and stop. A clean report that
takes five seconds to read is the point — padding it with everything that is
fine trains the merchant to skim past the day something is wrong.

## Do not

- Do not contact a customer, and do not draft a message unless asked.
- Do not change an order's status: every tool here is read-only.
- Do not guess at why a payment failed from the order record alone — the
  gateway's own reason is not in it.
