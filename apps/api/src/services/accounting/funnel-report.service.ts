import { currentStoreId, prisma } from '@ebda/database';
import { storeDb } from '../../lib/repo-factory';

/**
 * Funnel read model over `funnel_snapshots` (one row per store per Cairo day,
 * written by the nightly `runFunnelRollup`). Shared by
 * `GET /insights/funnel` and the merchant MCP `admin_get_funnel` tool so the
 * two cannot disagree about the rows they read.
 */

export const FUNNEL_WINDOWS = [7, 30, 90] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];

export async function listFunnelSnapshots(storeId: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return (await storeDb(currentStoreId())).funnelSnapshot.findMany({
    where: { storeId, periodDate: { gte: since } },
    orderBy: { periodDate: 'desc' },
  });
}

/**
 * Owner ruling AUD-2: a stage the platform cannot capture for guest shoppers
 * is reported as `null` WITH a reason — never as 0, which reads as "nobody
 * did this". Both stages below are derived from `abandoned_carts`, which is
 * only written for carts attached to a registered customer with contact
 * details (`abandoned-cart.service.ts`); guest checkouts — nearly all orders
 * on the stores audited 2026-09-30 — never produce a row.
 */
export const GUEST_UNCAPTURABLE_STAGES = {
  checkoutsStarted:
    'Not measured: checkout starts are only recorded for signed-in shoppers with ' +
    'contact details (abandoned-cart rows), so guest checkouts are invisible. ' +
    'A 0 here would be false.',
  ordersAbandoned:
    'Not measured: abandonment is derived from abandoned-cart rows, which guest ' +
    'carts never produce.',
} as const;

interface FunnelRowLike {
  periodDate: Date;
  productViews: number;
  cartsCreated: number;
  cartItemsAdded: number;
  ordersCompleted: number;
  revenueFils: number;
}

const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;

/**
 * Views → carts → orders over the snapshot rows. With no rows at all (the
 * rollup has not run for this window) every stage is `null` — unknown, not
 * zero. Rates are `null` when their denominator is 0.
 */
export function summarizeFunnel(rows: ReadonlyArray<FunnelRowLike>, windowDays: number) {
  const covered = rows.length;
  const sum = (k: keyof Omit<FunnelRowLike, 'periodDate'>) =>
    covered > 0 ? rows.reduce((s, r) => s + r[k], 0) : null;

  const productViews = sum('productViews');
  const cartsCreated = sum('cartsCreated');
  const cartItemsAdded = sum('cartItemsAdded');
  const ordersCompleted = sum('ordersCompleted');
  const revenueFils = sum('revenueFils');

  return {
    windowDays,
    daysCovered: covered,
    ...(covered === 0
      ? { note: 'No funnel rollup rows exist for this window yet; every stage is unknown.' }
      : {}),
    stages: {
      productViews,
      cartsCreated,
      cartItemsAdded,
      checkoutsStarted: null,
      ordersCompleted,
    },
    rates: {
      viewToCart:
        productViews !== null && cartsCreated !== null ? rate(cartsCreated, productViews) : null,
      cartToOrder:
        cartsCreated !== null && ordersCompleted !== null
          ? rate(ordersCompleted, cartsCreated)
          : null,
      viewToOrder:
        productViews !== null && ordersCompleted !== null
          ? rate(ordersCompleted, productViews)
          : null,
    },
    revenueFils,
    unavailable: Object.entries(GUEST_UNCAPTURABLE_STAGES).map(([stage, reason]) => ({
      stage,
      reason,
    })),
    days: rows.map(r => ({
      date: r.periodDate.toISOString().slice(0, 10),
      productViews: r.productViews,
      cartsCreated: r.cartsCreated,
      cartItemsAdded: r.cartItemsAdded,
      checkoutsStarted: null,
      ordersCompleted: r.ordersCompleted,
      ordersAbandoned: null,
      revenueFils: r.revenueFils,
    })),
  };
}
