# OD-6a

> Section: 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-6a — receive refuses an old-shape variant-less PO line on a variant product; no
auto-repair.** A line drafted before the per-variant rule names no variant, so there is no correct
row to write: the parent column must stay 0 (inventory-model.md) and picking a variant would be a
guess. `receivePurchaseOrder` throws 400 `VARIANT_REQUIRED` and the merchant cancels + redrafts.
Cost if wrong: a merchant holding an already-sent old-shape PO must redraft it before receiving, and
the receive screen shows an error until they do.
