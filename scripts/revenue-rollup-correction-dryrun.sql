-- STORE-QA-7 dry run: SELECT ONLY. Run once per store against its own database (SQLite flavour for a StoreDO / D1 store;
-- for Postgres replace MIN/MAX scalar with LEAST/GREATEST and prefix tables with public.).
-- Lists every Cairo-day funnel_snapshots row whose stored revenue_fils differs from the ONE revenue definition
-- (packages/repo/src/revenue.ts, paid-only) recomputed from the orders: these are the rows the correction must rewrite.
-- periodDate is the Cairo day-start instant; an order belongs to a row when created_at is in [period_date, period_date + 1 day)
-- (a DST day is 23/25 h: the join below is approximate for those two days a year; the apply path recomputes exactly via
-- runFunnelRollup, this query is only the COUNT).
WITH net AS (
  SELECT o.id, o.created_at,
         o.total - MIN(o.total, MAX(
           COALESCE((SELECT SUM(rt.refund_amount) FROM returns rt WHERE rt.order_id = o.id AND rt.status = 'completed' AND rt.type <> 'exchange'), 0),
           COALESCE((SELECT SUM(pm.refunded_amount) FROM payments pm WHERE pm.order_id = o.id), 0))) AS net_total
    FROM orders o
   WHERE o.deleted_at IS NULL
     AND o.status NOT IN ('cancelled', 'refunded', 'awaiting_payment_confirmation')
     AND o.payment_status NOT IN ('failed', 'refunded')
     AND o.payment_status = 'paid'
)
SELECT f.period_date, f.revenue_fils AS stored,
       COALESCE((SELECT SUM(n.net_total) FROM net n WHERE n.created_at >= f.period_date AND n.created_at < f.period_date + 86400000), 0) AS corrected
  FROM funnel_snapshots f
 WHERE f.revenue_fils <> COALESCE((SELECT SUM(n.net_total) FROM net n WHERE n.created_at >= f.period_date AND n.created_at < f.period_date + 86400000), 0)
 ORDER BY f.period_date;
