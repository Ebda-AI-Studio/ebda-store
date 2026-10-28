# OD-6b

> Section: 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-6b — a variant with no rule of its own falls back to the product's rule, then to the
product's `lowStockThreshold`, applied per variant.** There is no per-variant threshold column; the
product-level rule/threshold is the only merchant input that exists. Cost if wrong: a product with
many variants gets its product-level minimum applied to EACH variant, so reorder suggestions fire
per variant at that threshold (a merchant who meant it as a product total sees more suggestions).
