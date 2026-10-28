# EWO-D3

> Section: Cluster D — checkout + cart

**Ruling EWO-D3 — #2053: the bundle stock note keeps its quantity-aware trigger; its copy now
names the case, and no client-side submit block is added.** The finding's premise — that the
server gate is only the boolean `isPurchasable` — is incomplete: `OrderService.create`'s atomic
per-component decrement (Ruling T5-c) refuses `INSUFFICIENT_INVENTORY` whenever stock is below the
requested quantity, so `available < quantity` IS the server's semantic, and the checkout already
maps that refusal to copy (`checkout-bundle-errors.ts`). What was wrong was the label: "Out of
stock" for a box with 2 of 5 left. It now reads "Only N available" (`available > 0`) or "Out of
stock" (`0`), en + ar, pinned by a jsdom render test over both layouts. The Pay button is NOT
disabled client-side because backorder eligibility (the feature flag + per-product
`allowBackorder`) is not in the cart payload, and the decrement accepts a backordered component —
blocking there would refuse orders the server takes. Cost if wrong: a shopper who ignores the note
submits and meets the server's INSUFFICIENT_INVENTORY copy one round-trip later.
