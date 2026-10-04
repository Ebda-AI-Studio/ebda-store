/**
 * Database half of a scenario snapshot, read with plain SQL (psql) so the
 * reader is identical for both refs. Rows are selected as whole `to_jsonb`
 * rows: a column a ref ADDS shows up as an added field in the diff, a column it
 * DROPS shows up as a removed one — schema drift on the money tables is never
 * silently ignored.
 */
import { execFileSync } from 'node:child_process';

export function psqlJson(dbUrl, sql) {
  const out = execFileSync('psql', [dbUrl, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.trim() || 'null');
}

export function psqlExec(dbUrl, sql) {
  execFileSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const lit = arr => `ARRAY[${arr.map(v => `'${String(v).replace(/'/g, "''")}'`).join(',')}]::text[]`;

function agg(dbUrl, from, orderBy) {
  return psqlJson(
    dbUrl,
    `SELECT coalesce(json_agg(r ORDER BY ${orderBy}), '[]'::json) FROM (${from}) r`
  );
}

/** Columns every snapshot drops: pure bookkeeping, never money or state. */
const VOLATILE = ['created_at', 'updated_at', 'occurred_at', 'received_at'];
const strip = rows =>
  rows.map(r => {
    const o = { ...r };
    for (const k of VOLATILE) delete o[k];
    return o;
  });

export function snapshotDb(dbUrl, { orderIds, productIds, variantIds, couponIds }) {
  const oids = lit(orderIds.length ? orderIds : ['00000000-0000-0000-0000-000000000000']);
  const pids = lit(productIds.length ? productIds : ['00000000-0000-0000-0000-000000000000']);
  const vids = lit(variantIds.length ? variantIds : ['00000000-0000-0000-0000-000000000000']);
  const cids = lit(couponIds.length ? couponIds : ['00000000-0000-0000-0000-000000000000']);

  // Order rows follow the order in which the scenario created them.
  const orders = agg(
    dbUrl,
    `SELECT to_jsonb(o) AS j, o.id FROM public.orders o WHERE o.id = ANY(${oids})`,
    `array_position(${oids}, r.id)`
  ).map(r => {
    const o = { ...r.j };
    // Customer wallet (b1b5bbd1) added `wallet_amount` with default 0. A ref
    // without the column is, by definition, a ref where no wallet money moved.
    if (!('wallet_amount' in o)) o.wallet_amount = 0;
    return o;
  });

  const orderItems = agg(
    dbUrl,
    `SELECT to_jsonb(i) AS j, i.order_id, i.product_name, i.variant_name, i.bundle_name, i.quantity, i.price
       FROM public.order_items i WHERE i.order_id = ANY(${oids})`,
    `array_position(${oids}, r.order_id), r.bundle_name NULLS FIRST, r.product_name, r.variant_name NULLS FIRST, r.price, r.quantity`
  ).map(r => r.j);

  const payments = agg(
    dbUrl,
    `SELECT to_jsonb(p) AS j, p.order_id, p.created_at, p.provider FROM public.payments p WHERE p.order_id = ANY(${oids})`,
    `array_position(${oids}, r.order_id), r.created_at, r.provider`
  ).map(r => r.j);

  const paymentEvents = agg(
    dbUrl,
    `SELECT e.order_id, e.provider, e.event_type, e.from_status, e.to_status, e.details, e.created_at, e.occurred_at
       FROM public.payment_events e WHERE e.order_id = ANY(${oids})`,
    `array_position(${oids}, r.order_id), r.occurred_at, r.created_at, r.event_type, r.to_status`
  );

  const orderEvents = agg(
    dbUrl,
    `SELECT e.order_id, e.from_status, e.to_status, e.actor_id, e.metadata, e.created_at
       FROM public.order_events e WHERE e.order_id = ANY(${oids})`,
    `array_position(${oids}, r.order_id), r.created_at, r.to_status`
  );

  const products = agg(
    dbUrl,
    `SELECT p.id, p.name, p.inventory FROM public.products p WHERE p.id = ANY(${pids})`,
    'r.name'
  );
  const variants = agg(
    dbUrl,
    `SELECT v.id, v.sku, v.inventory FROM public.product_variants v WHERE v.id = ANY(${vids})`,
    'r.sku'
  );
  const inventoryHistory = agg(
    dbUrl,
    `SELECT h.product_id, h.type, h.quantity, h.previous_stock, h.new_stock, h.reason, h.reference, h.created_at
       FROM public.inventory_history h WHERE h.product_id = ANY(${pids})`,
    'r.created_at, r.product_id, r.type, r.quantity'
  );
  const coupons = agg(
    dbUrl,
    `SELECT c.id, c.code, c.usage_count, c.is_active FROM public.coupons c WHERE c.id = ANY(${cids})`,
    'r.code'
  );
  const webhookEvents = agg(
    dbUrl,
    `SELECT w.provider, w.idempotency_key, w.status, w.result_status, w.attempts, w.last_error, w.result_order_id, w.created_at
       FROM public.webhook_events w WHERE w.result_order_id = ANY(${oids})
          OR (w.payload #>> '{obj,order,id}') IN (SELECT p.transaction_id FROM public.payments p WHERE p.order_id = ANY(${oids}) AND p.transaction_id IS NOT NULL)`,
    'r.created_at, r.idempotency_key'
  );

  return {
    orders: strip(orders),
    orderItems: strip(orderItems),
    payments: strip(payments),
    paymentEvents: strip(paymentEvents),
    orderEventStatuses: orderEvents.map(e => `${e.from_status ?? '∅'}→${e.to_status}`),
    orderEvents: strip(orderEvents),
    inventory: { products, variants },
    inventoryHistory: strip(inventoryHistory),
    coupons,
    webhookEvents: strip(webhookEvents),
  };
}
