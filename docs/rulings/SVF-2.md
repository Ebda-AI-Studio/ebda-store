# SVF-2

> Section: 2026-09-30 — single-variant products (branch `fix/single-variant-products`)

**Ruling SVF-2 — order lines are unlinked only with `--unlink-order-lines`; without it the product
is blocked.** The brief said "do not hard-delete a variant an order references"; SVF-1 makes that
incompatible with flattening, so the default honours the brief and lists the product (29 of 58 on
demo-store, 2026-09-30). With the flag, `order_items.variant_id` is set to NULL (what the FK's
`ON DELETE SET NULL` does anyway) and every id is kept in the backup for `--restore`. NULL is also
what the stock writers need afterwards: a cancel/return of that order restores onto
`products.inventory`, the row that now holds the stock. Cost if wrong: a report joining order lines
to variants shows those historical lines without a variant row.
