-- One-off cleanup: duplicate OPEN reorder suggestions + dead-stock flags.
-- NOT RUN AUTOMATICALLY. Needs Ahmad's approval before it touches production.
--
-- Why: until PR fix/analytics-batch-1 the weekly dead-stock scan and the daily
-- reorder scan looked their existing row up by the per-run `scanned_at`, so
-- every run inserted ANOTHER open row for the same item (2026-09-30 analytics
-- audit, finding 6). Live counts at audit time:
--   reorder_suggestions open: pecannbee 4156 rows / 143 items, wady-aljuz 783 / 29
--   deadstock_flags     open: wady-aljuz 5 rows / 1 product
-- The code fix stops new duplicates (it refreshes the item's one open row);
-- it does not touch the rows already there. This script does.
--
-- What it does: for each (store, product, variant) keeps the NEWEST open row
-- (latest scanned_at, then id) and marks every older open duplicate
-- `expired` — the status the scans' own 30-day expiry already uses. Nothing is
-- deleted, so it is reversible: the ids it touched are listed by the preview
-- query, and `UPDATE ... SET status = 'open' WHERE id IN (...)` undoes it.
-- Rows that are dismissed / accepted / already expired are never touched.
--
-- How to run (psql, as the DB owner — the tables have RLS):
--   1. Run the PREVIEW block alone and check the counts against the numbers above.
--   2. Run the APPLY block. It ends in ROLLBACK; change it to COMMIT only after
--      the in-transaction counts look right.
-- Safe to re-run: a second run finds no duplicates and updates 0 rows.

-- ─── PREVIEW (read-only) ─────────────────────────────────────────────────────
WITH ranked AS (
  SELECT id, store_id, product_id, variant_id,
         row_number() OVER (
           PARTITION BY store_id, product_id, variant_id
           ORDER BY scanned_at DESC, id DESC
         ) AS rn
  FROM public.reorder_suggestions
  WHERE status = 'open'
)
SELECT 'reorder_suggestions' AS tbl, store_id,
       count(*) FILTER (WHERE rn > 1) AS to_expire,
       count(*) FILTER (WHERE rn = 1) AS kept_open
FROM ranked GROUP BY store_id
UNION ALL
SELECT 'deadstock_flags', store_id,
       count(*) FILTER (WHERE rn > 1), count(*) FILTER (WHERE rn = 1)
FROM (
  SELECT id, store_id,
         row_number() OVER (
           PARTITION BY store_id, product_id, variant_id
           ORDER BY scanned_at DESC, id DESC
         ) AS rn
  FROM public.deadstock_flags
  WHERE status = 'open'
) d
GROUP BY store_id
ORDER BY 1, 2;

-- ─── APPLY ───────────────────────────────────────────────────────────────────
BEGIN;

WITH dup AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (
             PARTITION BY store_id, product_id, variant_id
             ORDER BY scanned_at DESC, id DESC
           ) AS rn
    FROM public.reorder_suggestions
    WHERE status = 'open'
  ) r
  WHERE rn > 1
)
UPDATE public.reorder_suggestions s
SET status = 'expired'
FROM dup
WHERE s.id = dup.id;

WITH dup AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (
             PARTITION BY store_id, product_id, variant_id
             ORDER BY scanned_at DESC, id DESC
           ) AS rn
    FROM public.deadstock_flags
    WHERE status = 'open'
  ) r
  WHERE rn > 1
)
UPDATE public.deadstock_flags f
SET status = 'expired'
FROM dup
WHERE f.id = dup.id;

-- Post-condition, inside the transaction: every item has at most one open row.
SELECT 'reorder_suggestions' AS tbl, count(*) AS open_rows,
       count(DISTINCT (store_id, product_id, variant_id)) AS open_items
FROM public.reorder_suggestions WHERE status = 'open'
UNION ALL
SELECT 'deadstock_flags', count(*), count(DISTINCT (store_id, product_id, variant_id))
FROM public.deadstock_flags WHERE status = 'open';

ROLLBACK; -- change to COMMIT once the counts above show open_rows = open_items
