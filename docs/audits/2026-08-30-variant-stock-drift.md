# Audit — variant stock drift (2026-08-30)

Production counts measured against the live database **before** the fix, so the
numbers survive the repair migration that erases the evidence.

## Corruption

| Metric                                                                  | Count     |
| ----------------------------------------------------------------------- | --------- |
| Products with negative `inventory`                                      | 24        |
| …of those, that have variants                                           | 24 / 24   |
| Variant products where parent ≠ Σ variant inventory                     | 166 / 191 |
| Variant products carrying a non-zero parent (rows the migration resets) | 63        |
| Non-variant products (parent IS their real stock — untouched)           | 285       |

Worst case: `Dehydrated Super Vegetable` (demo-store) — parent `-16`, variants
holding `1173`.

## Impact, per surface (demo-store store)

| Surface                                    | Reported before                                | Actual            |
| ------------------------------------------ | ---------------------------------------------- | ----------------- |
| Cart quantity change                       | `INSUFFICIENT_INVENTORY` on 92 active products | variants in stock |
| Inventory dashboard: products out of stock | 168 / 204                                      | 41                |
| Inventory dashboard: total stock on hand   | 33,268 units                                   | 270,883           |
| Analytics "Low Stock Alerts" card          | 134 products                                   | 41                |
| Low-stock email scan                       | zero variant products had ever alerted         | —                 |
| Dead-stock scan                            | whole variant catalogue valued at 0 on-hand    | —                 |
| In-stock search filter                     | excluded every variant product                 | —                 |
| WhatsApp catalog + order check             | every drifted product out of stock             | —                 |
| Payment links                              | `OUT_OF_STOCK` on every drifted product        | —                 |
| Admin product detail                       | "-16 in stock", coloured as low-stock amber    | 1173              |

## Root cause

`order.service.ts` decremented the parent product on every variant sale via an
unfloored helper; `purchase-order.service.ts` incremented it on every variant
receipt. A variant product's parent column starts at 0, so it only drifted.
The refund path incremented both rows and the payment rollback incremented
only the product, so the directions never cancelled.

## Fix

Plan: `docs/superpowers/plans/2026-08-30-variant-stock-drift.md`.
Rules: `docs/architecture/inventory-model.md`.
Migration: `20260830090000_zero_variant_parent_inventory` (63 rows).

## Adjacent finding (separate commit)

`tests/setup-e2e.ts`'s production-DB guard had **never executed**:
`isIntegrationRun` was derived from `process.argv` at module load, and under
`pool: 'forks'` a worker's argv carries no test paths. Its prod check was also
a denylist of one endpoint fragment that no longer matched the endpoint the
repo's own `.env` pointed at. Now detected per test file and rewritten as a
fail-closed allowlist.
