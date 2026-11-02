/**
 * The repricer (Ruling B5-13): the ONE writer of a gold row's `price`. It runs INSIDE the caller's
 * transaction, which has set `app.gold_reprice` (the database trigger `ebda_gold_price_guard` refuses
 * every other writer), and it prices with `computeGoldUnitPrice`, the ONE formula (SQL never
 * re-implements it).
 *
 * For a product with variants, `products.price` is the minimum ACTIVE variant price, so SQL sort and
 * filter, feeds, search results, JSON-LD and every card path stay correct without a single reader
 * change. A variant is priced by its resolved spec (a NULL spec field inherits the product's); a
 * variant whose mode is `fixed` keeps its own price.
 */
import { notifyCatalogChanged } from '../../lib/wa/catalog-state';
import { Prisma } from '@ebda/database';
import {
  computeGoldUnitPrice,
  resolveVariantGoldSpec,
  type GoldKarat,
  type GoldPriceSpec,
  type GoldRoundingStep,
  type MakingChargeType,
} from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { GOLD_CATALOGUE_CAP } from './gate';

type Tx = Prisma.TransactionClient;
export type RateLookup = ReadonlyMap<GoldKarat, { id: string; ratePerGram: number }>;

const CHUNK = 500;

/**
 * Test seam: called after each chunk of writes, so a test can fail the repricer MIDWAY and prove the
 * rate rows and every price roll back together. Inert in production (never set).
 */
export const repricerHooks: { afterChunk?: (writtenSoFar: number) => void } = {};

interface VariantRow {
  id: string;
  price: number | null;
  goldRateId: string | null;
  isActive: boolean;
  pricingMode: string | null;
  goldKarat: number | null;
  goldWeightMg: number | null;
  makingChargeType: string | null;
  makingChargeValue: number | null;
  goldMarginBps: number | null;
}
interface ProductRow {
  id: string;
  price: number;
  goldRateId: string | null;
  goldKarat: number | null;
  goldWeightMg: number | null;
  makingChargeType: string | null;
  makingChargeValue: number | null;
  goldMarginBps: number;
  variants: VariantRow[];
}

const productSelect = {
  id: true,
  price: true,
  goldRateId: true,
  goldKarat: true,
  goldWeightMg: true,
  makingChargeType: true,
  makingChargeValue: true,
  goldMarginBps: true,
  variants: {
    select: {
      id: true,
      price: true,
      goldRateId: true,
      isActive: true,
      pricingMode: true,
      goldKarat: true,
      goldWeightMg: true,
      makingChargeType: true,
      makingChargeValue: true,
      goldMarginBps: true,
    },
  },
} satisfies Prisma.ProductSelect;

/** Sets the transaction-local reprice flag; ALWAYS pair with {@link clearRepriceFlag}. */
export async function setRepriceFlag(tx: Pick<Tx, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`select set_config('app.gold_reprice', 'on', true)`;
}
export async function clearRepriceFlag(tx: Pick<Tx, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`select set_config('app.gold_reprice', '', true)`;
}

/** Runs `fn` with the guard flag on and clears it after, even on a throw, so the window is exactly `fn`. */
export async function withRepriceFlag<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await setRepriceFlag(tx);
  try {
    return await fn();
  } finally {
    await clearRepriceFlag(tx).catch(() => undefined);
  }
}

interface Plan {
  products: Array<{ id: string; price: number; rateId: string | null }>;
  variants: Array<{ id: string; price: number; rateId: string | null }>;
}

/**
 * Price one product (and its variants). `affected`: only gold rows whose resolved karat is in the set
 * are recomputed (a rate write for 21k leaves 18k rows alone); `null` = every gold row (a spec edit,
 * a rounding-step change). Returns the writes for rows whose price or rate stamp changed.
 */
function planProduct(
  p: ProductRow,
  rates: RateLookup,
  step: GoldRoundingStep,
  affected: ReadonlySet<GoldKarat> | null,
  out: Plan
): void {
  const productSpecFields = {
    karat: p.goldKarat,
    weightMg: p.goldWeightMg,
    makingChargeType: p.makingChargeType as MakingChargeType | null,
    makingChargeValue: p.makingChargeValue,
    marginBps: p.goldMarginBps,
  };
  const priceOf = (spec: GoldPriceSpec): { price: number; rateId: string } | null => {
    if (affected && !affected.has(spec.karat)) return null; // untouched by this rate write
    const rate = rates.get(spec.karat);
    if (!rate)
      throw new AppError(
        409,
        'GOLD_RATE_MISSING',
        `No ${spec.karat}k rate has been set for this store`,
        {
          karat: spec.karat,
        }
      );
    return { price: computeGoldUnitPrice(spec, rate.ratePerGram, step).unitPrice, rateId: rate.id };
  };

  if (p.variants.length === 0) {
    const spec = resolveVariantGoldSpec(
      { pricingMode: 'gold_rate', ...productSpecFields },
      { pricingMode: null }
    )!;
    const r = priceOf(spec);
    if (r && (r.price !== p.price || r.rateId !== p.goldRateId))
      out.products.push({ id: p.id, price: r.price, rateId: r.rateId });
    return;
  }

  // Variant product: price each variant, then the product = min ACTIVE variant price.
  const effective: Array<{ price: number; active: boolean }> = [];
  for (const v of p.variants) {
    const spec = resolveVariantGoldSpec(
      { pricingMode: 'gold_rate', ...productSpecFields },
      {
        pricingMode: v.pricingMode as 'fixed' | 'gold_rate' | null,
        karat: v.goldKarat,
        weightMg: v.goldWeightMg,
        makingChargeType: v.makingChargeType as MakingChargeType | null,
        makingChargeValue: v.makingChargeValue,
        marginBps: v.goldMarginBps,
      }
    );
    if (!spec) {
      // A fixed variant keeps its own price. One with none (legacy data; setProductPricing refuses it now)
      // is left out of the minimum: the product's own price IS that minimum, so counting it would only ratchet.
      if (v.price != null) effective.push({ price: v.price, active: v.isActive });
      continue;
    }
    const r = priceOf(spec);
    if (!r) {
      // untouched by this rate write: its stored price still counts (a gold variant is always priced)
      if (v.price != null) effective.push({ price: v.price, active: v.isActive });
      continue;
    }
    effective.push({ price: r.price, active: v.isActive });
    if (r.price !== v.price || r.rateId !== v.goldRateId)
      out.variants.push({ id: v.id, price: r.price, rateId: r.rateId });
  }
  if (effective.length === 0) return; // nothing priced to take a minimum of: the product keeps its price
  const pool = effective.some(e => e.active) ? effective.filter(e => e.active) : effective;
  const min = Math.min(...pool.map(e => e.price));
  if (min !== p.price) out.products.push({ id: p.id, price: min, rateId: null });
}

async function writePlan(tx: Tx, storeId: string, plan: Plan): Promise<number> {
  let n = 0;
  for (let i = 0; i < plan.products.length; i += CHUNK) {
    const c = plan.products.slice(i, i + CHUNK);
    n += await tx.$executeRaw`
      UPDATE products p
         SET price = v.price,
             gold_rate_id = coalesce(v.rate_id, p.gold_rate_id),
             updated_at = now()
        FROM (SELECT unnest(${c.map(x => x.id)}::text[]) AS id,
                     unnest(${c.map(x => x.price)}::int[]) AS price,
                     unnest(${c.map(x => x.rateId)}::text[]) AS rate_id) v
       WHERE p.id = v.id AND p.store_id = ${storeId}`;
    repricerHooks.afterChunk?.(n);
  }
  for (let i = 0; i < plan.variants.length; i += CHUNK) {
    const c = plan.variants.slice(i, i + CHUNK);
    await tx.$executeRaw`
      UPDATE product_variants pv
         SET price = v.price,
             gold_rate_id = v.rate_id,
             updated_at = now()
        FROM (SELECT unnest(${c.map(x => x.id)}::text[]) AS id,
                     unnest(${c.map(x => x.price)}::int[]) AS price,
                     unnest(${c.map(x => x.rateId)}::text[]) AS rate_id) v
       WHERE pv.id = v.id
         AND EXISTS (SELECT 1 FROM products p WHERE p.id = pv.product_id AND p.store_id = ${storeId})`;
    repricerHooks.afterChunk?.(plan.products.length + Math.min(i + CHUNK, plan.variants.length));
  }
  // A reprice changes prices of many products at once: raw SQL bypasses the db write observer, so
  // Ebda Chat is told here (whole catalog of the store).
  if (plan.products.length + plan.variants.length > 0) {
    await notifyCatalogChanged({ storeId, productIds: null });
  }
  return plan.products.length + plan.variants.length;
}

/**
 * Re-price every gold product of the store whose resolved karat is in `karats`. Runs inside the
 * caller's transaction (the rate write's), so the new rate and every price commit or roll back
 * together. Refuses a catalogue above {@link GOLD_CATALOGUE_CAP} gold products.
 */
export async function repriceStore(
  tx: Tx,
  storeId: string,
  karats: readonly GoldKarat[],
  rates: RateLookup,
  step: GoldRoundingStep
): Promise<number> {
  const rows = (await tx.product.findMany({
    where: { storeId, pricingMode: 'gold_rate', deletedAt: null },
    select: productSelect,
    take: GOLD_CATALOGUE_CAP + 1,
  })) as ProductRow[];
  if (rows.length > GOLD_CATALOGUE_CAP)
    throw new AppError(
      409,
      'GOLD_CATALOGUE_TOO_LARGE',
      `A store can hold at most ${GOLD_CATALOGUE_CAP} gold-priced products`
    );
  const plan: Plan = { products: [], variants: [] };
  const affected = new Set(karats);
  for (const p of rows) planProduct(p, rates, step, affected, plan);
  return writePlan(tx, storeId, plan);
}

/** Re-price ONE product after a spec or mode edit (every gold row of it, whatever the karat). */
export async function repriceProduct(
  tx: Tx,
  storeId: string,
  productId: string,
  rates: RateLookup,
  step: GoldRoundingStep
): Promise<void> {
  const p = (await tx.product.findFirst({
    where: { id: productId, storeId, pricingMode: 'gold_rate', deletedAt: null },
    select: productSelect,
  })) as ProductRow | null;
  if (!p) return;
  const plan: Plan = { products: [], variants: [] };
  planProduct(p, rates, step, null, plan);
  await writePlan(tx, storeId, plan);
}
