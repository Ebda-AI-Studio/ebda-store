---
name: catalog-audit
description: Use when the merchant wants to know what is wrong with their product listings — missing descriptions, images, SKUs, or prices — or asks why products are not being found in search or by AI shopping agents.
---

# Catalogue audit

Find the listings that will cost the merchant a sale, and rank them by how much
they cost. A list of every imperfect field is noise; the products that get
traffic and are badly described are the work.

## Gather

1. `admin_list_products` — start with `limit: 100`. This sees **draft and
   archived** products too, which the storefront does not; say which status a
   flagged product is in, because "missing description" on an archived product
   is not a problem.
2. `admin_get_analytics` — the `topProducts` list tells you which listings
   actually matter. A missing image on a best seller is worth more than a
   missing image on forty products nobody opens.
3. `admin_get_product` on the specific products you are going to flag — only
   those. The list payload does not carry descriptions, images or variants.

Page with `page` only if the store has more than 100 products AND you still
have unanswered questions after the first page.

## What actually costs a sale

In this order:

1. **Active product with no image.** Nothing else on this list loses as many
   sales.
2. **Active product with no description.** Both a shopper and an AI shopping
   agent read this; an agent that cannot tell what a product is will not
   recommend it.
3. **Active product with no Arabic name or description**, on a store whose
   customers read Arabic. Check `admin_get_store` — a bilingual storefront with
   English-only listings is half a catalogue.
4. **Missing SKU or barcode**, if the merchant does stock counts or uses a
   carrier — otherwise cosmetic, and say so.
5. **Price of 0 on an active product.** Almost always a mistake, and it is
   live right now.

## Report

Group by problem, not by product — a merchant fixes all the missing images in
one sitting, not one product at a time. For each group: how many, which ones
are top sellers (name them), and the single next action.

State the total scanned and whether you saw the whole catalogue: "42 of 42
products" or "the first 100 of 340". A reader who assumes you saw everything
when you saw a third will act on a wrong denominator.

## Do not

- Do not write the missing descriptions unless asked. This skill finds; the
  merchant decides whether an agent should be writing their copy.
- Do not flag a draft product for incompleteness — draft means unfinished.
- Do not offer to fix anything: every tool here is read-only.
