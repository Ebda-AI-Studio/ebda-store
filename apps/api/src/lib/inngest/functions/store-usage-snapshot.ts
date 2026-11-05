import type { JobDef } from '../../jobs/types';
import { analyticsOnDo } from '../../analytics-backend';
import { aiUsageTotals } from '../../../services/usage-aggregates.service';
import { platformFamilyOnD1 } from '../../../services/platform/cutover';
import { withStoreDb } from '../../jobs/store-db';
import { prisma, withStore, acrossStoresFlat } from '@ebda/database';
import { acrossOpts, alarmStoreId } from '../../jobs/store-scope';
import { storeMoney, storeRepo } from '../../repo-factory';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

/**
 * Monthly per-store usage snapshot — 03:00 UTC on the 1st.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every usage number in the platform was a POINT IN TIME. You could ask "how
 * many products does this store have" but never "how fast is it growing", so
 * plan-tier ceilings and per-client pricing had to be guessed rather than
 * derived from what merchants actually do. This writes the history that makes
 * them defensible — one row per store per closed calendar month.
 *
 * It captures the PREVIOUS month, never the current one: a snapshot of a month
 * still in progress would change every time it ran, which defeats the point.
 *
 * IDEMPOTENT by (storeId, periodStart) via upsert, so re-running it — or
 * backfilling a month by hand — overwrites cleanly instead of duplicating.
 *
 * TRAFFIC IS SPLIT ON PURPOSE. A cart row is created per storefront session, so
 * carts with no items approximate unique visitors on a normal browsing store.
 * But the ratio is wildly store-dependent: measured 2026-08, demo-store had 2687
 * empty / 135 with-items (classic browsing) while demo-shop had 93 / 1111
 * (carts arrive pre-filled through a different flow). A single "carts" number
 * would silently mean two different things, so both are stored and the reader
 * decides.
 *
 * Cross-tenant by nature (it reports on every store), so it runs inside
 * withRlsBypass — there is no HTTP tenant GUC on a cron.
 */
/**
 * A step's return value is memoized as JSON and replayed from JSON, and JSON
 * has no bigint. Every int8 column therefore crosses the `collect` step
 * boundary as an exact decimal string; the upsert turns it back into the type
 * its column needs (BigInt() for the BigInt columns, Number() for the Int
 * counts).
 */
export function toJsonSafeRows<T extends Record<string, unknown>>(
  rows: T[]
): Array<Record<keyof T, string>> {
  return rows.map(
    r =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : String(v)])
      ) as Record<keyof T, string>
  );
}

/**
 * One store on its Durable Object (Ruling CF-JOBS-4B): the catalogue and commerce counts come from the DO op `usageCounts`
 * (same definitions as the Postgres query below), the product-view and AI-usage numbers from the analytics tables, which stay
 * in Postgres; the `Store` row (deleted or not) is platform. Same row shape as the Postgres collection, so one upsert serves both.
 */
export async function collectDoStoreUsage(
  storeId: string,
  start: Date,
  end: Date
): Promise<Array<Record<string, number | bigint | string>>> {
  const store = await withStoreDb(storeId, db =>
    db.store.findUnique({ where: { id: storeId }, select: { deletedAt: true } })
  );
  if (!store || store.deletedAt) return [];
  const money = await storeMoney(storeId);
  if (!money) throw new Error(`store-usage-snapshot: no money client for DO store ${storeId}`);
  const c = await money.usageCounts({ startMs: start.getTime(), endMs: end.getTime() });
  // Ruling NZ-AN-1: product views live in the store's DO (`usageCounts.productViews`) and AI usage is one platform table on D1,
  // each once its cutover marker exists. Before a marker the number is still in Postgres (the store-scoped query below), so a
  // snapshot taken between the deploy and the copy is not silently zero.
  const viewsOnDo = await analyticsOnDo(storeId, 'read');
  const aiOnD1 = await platformFamilyOnD1('ai-usage');
  const ai = aiOnD1 ? await aiUsageTotals(storeId, start, end) : undefined;
  const [a] =
    viewsOnDo && aiOnD1
      ? []
      : await withStore(
          storeId,
          tx =>
            tx.$queryRaw<
              Array<{
                product_views: bigint;
                ai_calls: bigint;
                ai_billable_calls: bigint;
                ai_tokens_in: bigint;
                ai_tokens_out: bigint;
                ai_cost_micros: bigint;
                ai_unpriced_calls: bigint;
              }>
            >`
      SELECT
        (SELECT COALESCE(SUM(v.count), 0) FROM product_daily_views v
          WHERE v.store_id = ${storeId} AND v.date >= ${start} AND v.date < ${end}) AS product_views,
        (SELECT COUNT(*) FROM ai_usage a
          WHERE a.store_id = ${storeId} AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_calls,
        (SELECT COUNT(*) FROM ai_usage a
          WHERE a.store_id = ${storeId} AND a.created_at >= ${start} AND a.created_at < ${end}
            AND a.cached_hit = false) AS ai_billable_calls,
        (SELECT COALESCE(SUM(a.input_tokens), 0) FROM ai_usage a
          WHERE a.store_id = ${storeId} AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_tokens_in,
        (SELECT COALESCE(SUM(a.output_tokens), 0) FROM ai_usage a
          WHERE a.store_id = ${storeId} AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_tokens_out,
        (SELECT COALESCE(SUM(a.cost_micros), 0) FROM ai_usage a
          WHERE a.store_id = ${storeId} AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_cost_micros,
        (SELECT COUNT(*) FROM ai_usage a
          WHERE a.store_id = ${storeId} AND a.created_at >= ${start} AND a.created_at < ${end}
            AND a.cached_hit = false AND a.cost_micros IS NULL) AS ai_unpriced_calls
    `
        );
  return [
    {
      store_id: storeId,
      products: c.products,
      products_active: c.productsActive,
      variants: c.variants,
      images: c.images,
      categories: c.categories,
      orders: c.orders,
      revenue_fils: c.revenueFils,
      customers: c.customers,
      sessions_proxy: c.sessionsProxy,
      carts_with_items: c.cartsWithItems,
      product_views: viewsOnDo ? c.productViews : (a?.product_views ?? 0),
      ai_calls: ai ? ai.calls : (a?.ai_calls ?? 0),
      ai_billable_calls: ai ? ai.billableCalls : (a?.ai_billable_calls ?? 0),
      ai_tokens_in: ai ? ai.tokensIn : (a?.ai_tokens_in ?? 0),
      ai_tokens_out: ai ? ai.tokensOut : (a?.ai_tokens_out ?? 0),
      ai_cost_micros: ai ? ai.costMicros : (a?.ai_cost_micros ?? 0),
      ai_unpriced_calls: ai ? ai.unpricedCalls : (a?.ai_unpriced_calls ?? 0),
    },
  ];
}

export const storeUsageSnapshot: JobDef = inngest.createFunction(
  {
    id: 'store-usage-snapshot',
    name: 'Monthly per-store usage snapshot',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 1 * *' }], // 03:00 UTC, 1st of each month
  },
  async ({ step, event }) => {
    // Allow a manual/backfill invocation to name the month explicitly
    // (`{ data: { periodStart: '2026-07-01' } }`); default to last month.
    const explicit = (event?.data as { periodStart?: string } | undefined)?.periodStart;

    const { periodStart, periodEnd } = await step.run('resolve-period', async () => {
      const now = new Date();
      const start = explicit
        ? new Date(`${explicit}T00:00:00.000Z`)
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      if (Number.isNaN(start.getTime())) {
        throw new Error(`store-usage-snapshot: invalid periodStart "${explicit}"`);
      }
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
    });

    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    const onlyStore = alarmStoreId(event);
    const rows = await step.run('collect', async () =>
      onlyStore && (await storeRepo(onlyStore)).backend === 'do'
        ? toJsonSafeRows(await collectDoStoreUsage(onlyStore, start, end))
        : // Every table read below is store-scoped under RLS, so the collection runs
          // store by store (`acrossStoresFlat`: one short tenant transaction each),
          // one joined SQL pass per store rather than N queries per store.
          acrossStoresFlat(async storeId => {
            return prisma.$queryRaw<
              Array<{
                store_id: string;
                products: bigint;
                products_active: bigint;
                variants: bigint;
                images: bigint;
                categories: bigint;
                orders: bigint;
                revenue_fils: bigint;
                customers: bigint;
                sessions_proxy: bigint;
                carts_with_items: bigint;
                product_views: bigint;
                ai_calls: bigint;
                ai_billable_calls: bigint;
                ai_tokens_in: bigint;
                ai_tokens_out: bigint;
                ai_cost_micros: bigint;
                ai_unpriced_calls: bigint;
              }>
            >`
          SELECT
            s.id AS store_id,

            -- Catalog is CURRENT state, not period state: there is no history
            -- of "how many products existed in July", and a merchant's catalog
            -- size is what drives storage + admin effort today.
            (SELECT COUNT(*) FROM products p
              WHERE p.store_id = s.id AND p.deleted_at IS NULL) AS products,
            (SELECT COUNT(*) FROM products p
              WHERE p.store_id = s.id AND p.deleted_at IS NULL AND p.status = 'active') AS products_active,
            (SELECT COUNT(*) FROM product_variants v
              JOIN products p ON p.id = v.product_id
              WHERE p.store_id = s.id AND p.deleted_at IS NULL) AS variants,
            (SELECT COUNT(*) FROM product_images pi
              JOIN products p ON p.id = pi.product_id
              WHERE p.store_id = s.id AND p.deleted_at IS NULL) AS images,
            (SELECT COUNT(*) FROM categories c WHERE c.store_id = s.id) AS categories,

            -- Commerce is PERIOD state.
            (SELECT COUNT(*) FROM orders o
              WHERE o.store_id = s.id AND o.created_at >= ${start} AND o.created_at < ${end}) AS orders,
            -- NET revenue: money collected AND kept. payment_status = 'paid'
            -- alone is not enough — production contains paid+refunded and
            -- paid+cancelled orders (demo-store 3, demo-shop 2 as of 2026-08),
            -- and counting those would inflate revenue for exactly the stores
            -- with the most reversals. Delivered-but-still-unpaid orders are
            -- excluded too; they are a bookkeeping gap, not revenue.
            (SELECT COALESCE(SUM(o.total), 0) FROM orders o
              WHERE o.store_id = s.id AND o.created_at >= ${start} AND o.created_at < ${end}
                AND o.payment_status = 'paid'
                AND o.status NOT IN ('cancelled', 'refunded')) AS revenue_fils,
            (SELECT COUNT(*) FROM customers cu
              WHERE cu.store_id = s.id AND cu.created_at >= ${start} AND cu.created_at < ${end}) AS customers,

            (SELECT COUNT(*) FROM carts c
              WHERE c.store_id = s.id AND c.created_at >= ${start} AND c.created_at < ${end}
                AND NOT EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)) AS sessions_proxy,
            (SELECT COUNT(*) FROM carts c
              WHERE c.store_id = s.id AND c.created_at >= ${start} AND c.created_at < ${end}
                AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)) AS carts_with_items,
            (SELECT COALESCE(SUM(v.count), 0) FROM product_daily_views v
              WHERE v.store_id = s.id AND v.date >= ${start} AND v.date < ${end}) AS product_views,

            (SELECT COUNT(*) FROM ai_usage a
              WHERE a.store_id = s.id AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_calls,
            (SELECT COUNT(*) FROM ai_usage a
              WHERE a.store_id = s.id AND a.created_at >= ${start} AND a.created_at < ${end}
                AND a.cached_hit = false) AS ai_billable_calls,
            (SELECT COALESCE(SUM(a.input_tokens), 0) FROM ai_usage a
              WHERE a.store_id = s.id AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_tokens_in,
            (SELECT COALESCE(SUM(a.output_tokens), 0) FROM ai_usage a
              WHERE a.store_id = s.id AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_tokens_out,
            -- COALESCE only the SUM: rows with NULL cost contribute nothing,
            -- and are counted separately so an unpriced month is not read as free.
            (SELECT COALESCE(SUM(a.cost_micros), 0) FROM ai_usage a
              WHERE a.store_id = s.id AND a.created_at >= ${start} AND a.created_at < ${end}) AS ai_cost_micros,
            (SELECT COUNT(*) FROM ai_usage a
              WHERE a.store_id = s.id AND a.created_at >= ${start} AND a.created_at < ${end}
                AND a.cached_hit = false AND a.cost_micros IS NULL) AS ai_unpriced_calls

          FROM stores s
          WHERE s.id = ${storeId} AND s.deleted_at IS NULL
        `;
          }, acrossOpts(event))
            .then(r => withAiUsageFromD1(r, start, end))
            .then(toJsonSafeRows)
    );

    let written = 0;
    for (const r of rows) {
      await step.run(`upsert-${r.store_id}`, async () =>
        withStore(r.store_id, async tx => {
          const data = {
            products: Number(r.products),
            productsActive: Number(r.products_active),
            variants: Number(r.variants),
            images: Number(r.images),
            categories: Number(r.categories),
            orders: Number(r.orders),
            // #1057: revenue_fils/product_views/ai_tokens_in/ai_tokens_out/
            // ai_cost_micros are BigInt columns — rebuilt with BigInt() from
            // the exact decimal string the collect step returned, never
            // through Number(), which is the truncation that migration exists
            // to stop.
            revenueFils: BigInt(r.revenue_fils),
            customers: Number(r.customers),
            sessionsProxy: Number(r.sessions_proxy),
            cartsWithItems: Number(r.carts_with_items),
            productViews: BigInt(r.product_views),
            aiCalls: Number(r.ai_calls),
            aiBillableCalls: Number(r.ai_billable_calls),
            aiTokensIn: BigInt(r.ai_tokens_in),
            aiTokensOut: BigInt(r.ai_tokens_out),
            aiCostMicros: BigInt(r.ai_cost_micros),
            aiUnpricedCalls: Number(r.ai_unpriced_calls),
            capturedAt: new Date(),
          };
          await tx.storeUsageSnapshot.upsert({
            where: { storeId_periodStart: { storeId: r.store_id, periodStart: start } },
            create: { storeId: r.store_id, periodStart: start, ...data },
            update: data,
          });
        })
      );
      written += 1;
    }

    // Zero stores is not "nothing to do" — it means the query or the tenant
    // table is wrong, and silence would hide it until someone needed the data
    // months later, by which point the history is unrecoverable.
    if (written === 0) {
      void sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'store-usage-snapshot.empty',
        title: 'store-usage-snapshot wrote 0 rows',
        body: `No stores were snapshotted for ${periodStart.slice(0, 10)}. Usage history for that month is missing and cannot be reconstructed later.`,
        context: { periodStart },
      }).catch(() => undefined);
    }

    logger.info(
      { periodStart: periodStart.slice(0, 10), stores: written },
      'store-usage-snapshot completed'
    );
    return { periodStart: periodStart.slice(0, 10), stores: written };
  }
);

/**
 * Ruling NZ-AN-1: once the `ai-usage` family is on D1 the Postgres `ai_usage` table is frozen history, so the AI columns of a
 * Postgres store's row come from D1 (the same definitions); before the marker the joined SQL above is the truth.
 */
async function withAiUsageFromD1<
  T extends {
    store_id: string;
    ai_calls: bigint;
    ai_billable_calls: bigint;
    ai_tokens_in: bigint;
    ai_tokens_out: bigint;
    ai_cost_micros: bigint;
    ai_unpriced_calls: bigint;
  },
>(rows: T[], start: Date, end: Date): Promise<T[]> {
  if (!(await platformFamilyOnD1('ai-usage'))) return rows;
  // bounded parallelism (8 stores at a time, 4 statements each): serial was 4 sequential D1 round trips per store
  const out: T[] = new Array(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, rows.length) }, async () => {
      while (next < rows.length) {
        const i = next++;
        const r = rows[i];
        const ai = await aiUsageTotals(r.store_id, start, end);
        out[i] = {
          ...r,
          ai_calls: BigInt(ai.calls),
          ai_billable_calls: BigInt(ai.billableCalls),
          ai_tokens_in: BigInt(ai.tokensIn),
          ai_tokens_out: BigInt(ai.tokensOut),
          ai_cost_micros: BigInt(ai.costMicros),
          ai_unpriced_calls: BigInt(ai.unpricedCalls),
        };
      }
    })
  );
  return out;
}
