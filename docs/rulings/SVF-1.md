# SVF-1

> Section: 2026-09-30 — single-variant products (branch `fix/single-variant-products`)

**Ruling SVF-1 — flattening DELETES the variant row; it does not disable it.** Every stock reader
keys "variant product" on the existence of ANY variant row, disabled ones included
(`effectiveInventory`, `ON_HAND_SQL`, `STOCK_VALUE_SQL`, #2147): a product whose only variant is
disabled has stock 0 and cannot be ordered. Soft-disabling would therefore make these products
unsellable. Deleting is what the platform's own "delete option" action already does
(`VariantService.deleteOption`). Cost if wrong: order lines lose the FK link to a variant row that no
longer exists; their snapshot (`variant_name`, `sku`, `price`, `cost_price`) is untouched.
