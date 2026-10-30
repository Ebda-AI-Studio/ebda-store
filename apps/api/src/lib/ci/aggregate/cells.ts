/**
 * CI-2 cells: the pure fold from `commerce_outcomes` envelopes to additive counters
 * (docs/plans/2026-10-28-customer-intelligence.md 3.1, Ruling CI-9). Nothing here reads I/O, a person
 * or a buyer: an envelope's `buyerKey` and `orderId` are never looked at, so a cell cannot carry them.
 *
 * A cell is `{ n, hit, sum, first, last }`: `n` outcomes, `hit` of them the thing the metric counts
 * (a return, a confirmation), `sum` the metric's hours, `first`/`last` the first and last UTC day that
 * fed it. Counters are additive, so a day, a 90-day window and a cross-store cohort are all merges of
 * the same shape. `own` folds every event of the store; `shared` only the events with `xstore: true`
 * (the merchant's opt-in AT EVENT TIME), which is the only part that ever leaves the store.
 */
import type { CiEnvelope } from '../envelope';

export const METRICS = [
  'return_rate',
  'delivery_hours',
  'cod_confirmation',
  'cod_return_by_amount',
  /** COD returns by what the buyer was charged for shipping (CI-13; replaces the amount proxy in the fee hint). */
  'return_by_shipping_fee',
  /** Captured vs failed online payments per provider (`n` settled, `hit` failed). */
  'payment_failure',
  /** Store-setup funnel: one count per (step), `sum` = seconds since signup, so mean time-to-step = sum / n. */
  'onboarding_step',
  /** Abandoned-cart recovery per channel: `n` carts reminded (step 1), `hit` recovered, `sum` hours to recover. */
  'cart_recovery',
] as const;
export type Metric = (typeof METRICS)[number];

export interface Cell {
  n: number;
  hit: number;
  sum: number;
  first: string;
  last: string;
}
export type Cells = Record<Metric, Record<string, Cell>>;

/** Any carrier / any area / any amount: the rollup a baseline is read from. */
export const ANY = '*';
const KEY_SEP = '|';

/** COD amount buckets in EGP piastres (upper bound exclusive); the last one is open. */
export const AMOUNT_BUCKET_EDGES_MINOR = [20_000, 50_000, 100_000, 200_000] as const;
export const amountBucket = (codMinor: number): string => {
  const i = AMOUNT_BUCKET_EDGES_MINOR.findIndex(edge => codMinor < edge);
  return `b${i === -1 ? AMOUNT_BUCKET_EDGES_MINOR.length : i}`;
};
/** Lower edge (piastres) of a bucket, for "orders above X". */
export const bucketLowerMinor = (bucket: string): number => {
  const i = Number(bucket.slice(1));
  return i === 0 ? 0 : AMOUNT_BUCKET_EDGES_MINOR[i - 1]!;
};

/** Shipping-fee buckets in EGP piastres (upper bound exclusive): free, <50, <75, <100, 100+ EGP. */
export const FEE_BUCKET_EDGES_MINOR = [1, 5_000, 7_500, 10_000] as const;
export const feeBucket = (feeMinor: number): string => {
  const i = FEE_BUCKET_EDGES_MINOR.findIndex(edge => feeMinor < edge);
  return `f${i === -1 ? FEE_BUCKET_EDGES_MINOR.length : i}`;
};
/** Lower edge (piastres) of a fee bucket. */
export const feeBucketLowerMinor = (bucket: string): number => {
  const i = Number(bucket.slice(1));
  return i === 0 ? 0 : FEE_BUCKET_EDGES_MINOR[i - 1]!;
};

export const cellKey = (...dims: string[]) => dims.join(KEY_SEP);
export const splitKey = (key: string) => key.split(KEY_SEP);

/** `EG-C-nasr-city` -> [`EG-C-nasr-city`, `EG-C`]; a governorate-only key or no key has no finer level. */
export function areaLevels(areaKey: string | null | undefined): string[] {
  if (!areaKey) return [];
  const parts = areaKey.split('-');
  const gov = parts.slice(0, 2).join('-');
  return gov === areaKey ? [areaKey] : [areaKey, gov];
}

export const emptyCells = (): Cells => ({
  return_rate: {},
  delivery_hours: {},
  cod_confirmation: {},
  cod_return_by_amount: {},
  return_by_shipping_fee: {},
  payment_failure: {},
  onboarding_step: {},
  cart_recovery: {},
});

function bump(
  cells: Cells,
  m: Metric,
  key: string,
  day: string,
  hit: boolean,
  sum = 0,
  counts = true
): void {
  const c = (cells[m][key] ??= { n: 0, hit: 0, sum: 0, first: day, last: day });
  if (counts) c.n += 1;
  c.hit += hit ? 1 : 0;
  c.sum += sum;
  if (day < c.first) c.first = day;
  if (day > c.last) c.last = day;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Folds one envelope into `cells`. Event types that no metric reads are ignored. */
export function foldEvent(cells: Cells, e: CiEnvelope): void {
  const day = utcDay(e.recordedAt);
  switch (e.type) {
    case 'shipment.delivered':
    case 'shipment.returned': {
      const returned = e.type === 'shipment.returned';
      const areas = [...areaLevels(e.data.areaKey), ANY];
      for (const carrier of [e.data.carrier, ANY]) {
        for (const area of areas) bump(cells, 'return_rate', cellKey(carrier, area), day, returned);
      }
      if (e.type === 'shipment.delivered' && e.data.hoursSincePickup != null) {
        for (const carrier of [e.data.carrier, ANY]) {
          for (const area of areas) {
            bump(
              cells,
              'delivery_hours',
              cellKey(carrier, area),
              day,
              true,
              e.data.hoursSincePickup
            );
          }
        }
      }
      if (e.data.codMinor > 0) {
        for (const b of [amountBucket(e.data.codMinor), ANY]) {
          bump(cells, 'cod_return_by_amount', b, day, returned);
        }
        // Older events carry no fee (null/absent): they are not counted, never read as a free-shipping order.
        if (e.data.shippingFeeMinor != null) {
          for (const b of [feeBucket(e.data.shippingFeeMinor), ANY]) {
            bump(cells, 'return_by_shipping_fee', b, day, returned);
          }
        }
      }
      return;
    }
    case 'payment.captured':
    case 'payment.failed': {
      if (e.data.provider === 'cod') return; // cash on delivery never goes through a gateway
      for (const p of [e.data.provider, ANY]) {
        bump(cells, 'payment_failure', p, day, e.type === 'payment.failed');
      }
      return;
    }
    case 'merchant.onboarding_step': {
      bump(cells, 'onboarding_step', e.data.step, day, true, e.data.secondsSinceSignup ?? 0);
      return;
    }
    case 'cart.abandoned': {
      // One count per cart and channel: only the first reminder (step 1) opens the denominator.
      if (e.data.step !== 1) return;
      for (const ch of [e.data.channel, ANY]) bump(cells, 'cart_recovery', ch, day, false);
      return;
    }
    case 'cart.recovered': {
      for (const ch of [e.data.channel, ANY]) {
        bump(cells, 'cart_recovery', ch, day, true, e.data.hoursToRecover ?? 0, false);
      }
      return;
    }
    case 'order.cod_confirmed':
    case 'order.cod_unconfirmed': {
      for (const area of [...areaLevels(e.data.areaKey), ANY]) {
        bump(cells, 'cod_confirmation', area, day, e.type === 'order.cod_confirmed');
      }
      return;
    }
    default:
      return;
  }
}

export function mergeCells(into: Cells, from: Cells): Cells {
  for (const m of METRICS) {
    // A day file written before a metric existed has no key for it.
    for (const [key, c] of Object.entries(from[m] ?? {})) {
      const t = into[m][key];
      if (!t) {
        into[m][key] = { ...c };
        continue;
      }
      t.n += c.n;
      t.hit += c.hit;
      t.sum += c.sum;
      if (c.first < t.first) t.first = c.first;
      if (c.last > t.last) t.last = c.last;
    }
  }
  return into;
}

/** Stable key order, so the same input always serialises to the same bytes (a replay is a no-op). */
export function sortCells(cells: Cells): Cells {
  const out = emptyCells();
  for (const m of METRICS) {
    for (const k of Object.keys(cells[m] ?? {}).sort()) {
      const c = cells[m][k]!;
      out[m][k] = {
        n: c.n,
        hit: c.hit,
        sum: Math.round(c.sum * 100) / 100,
        first: c.first,
        last: c.last,
      };
    }
  }
  return out;
}

export interface StoreDay {
  v: 1;
  storeId: string;
  day: string;
  own: Cells;
  shared: Cells;
}

/** Events for ONE store and ONE day -> its day file. Dedupes on `eventId` (delivery is at-least-once). */
export function foldStoreDay(storeId: string, day: string, events: CiEnvelope[]): StoreDay {
  const own = emptyCells();
  const shared = emptyCells();
  const seen = new Set<string>();
  for (const e of events) {
    if (e.storeId !== storeId || utcDay(e.recordedAt) !== day || seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    foldEvent(own, e);
    if (e.xstore) foldEvent(shared, e);
  }
  return { v: 1, storeId, day, own: sortCells(own), shared: sortCells(shared) };
}

/** Whole days from `a` to `b` (UTC `YYYY-MM-DD`). */
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
