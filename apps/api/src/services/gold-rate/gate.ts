/**
 * Gold-rate pricing: rate reads, freshness and the typed 409s every order path shares
 * (Rulings B5-16, B5-17, B5-20). The RATE READS ARE NEVER CACHED: the checkout gate, the admin rate
 * page and the repricer read the database directly, because a price is NEVER-stale data.
 */
import { Prisma } from '@ebda/database';
import {
  GOLD_KARATS,
  computeGoldUnitPrice,
  resolveVariantGoldSpec,
  type GoldKarat,
  type GoldLineSnapshot,
  type GoldPriceSpec,
  type GoldRoundingStep,
  type MakingChargeType,
} from '@ebda/shared';
import { sendAlert } from '../alerts.service';
import { AppError } from '../../middleware/error-handler';

/** The interactive-transaction client shape (the root client is cast to it at the read sites, as other services do). */
export type GoldDb = Prisma.TransactionClient;

export interface CurrentRate {
  karat: GoldKarat;
  rateId: string;
  ratePerGram: number;
  appliedAt: Date;
}

export interface GoldSettings {
  enabled: boolean;
  feedEnabled: boolean;
  feedPremiumBps: number;
  maxAgeMinutes: number;
  jumpConfirmBps: number;
  roundingStep: GoldRoundingStep;
  showBreakdown: boolean;
}

/** What a store that never saved settings gets. 26 hours is the default AND the ceiling (Ruling B5-16). */
export const DEFAULT_GOLD_SETTINGS: GoldSettings = {
  enabled: false,
  feedEnabled: false,
  feedPremiumBps: 0,
  maxAgeMinutes: 1560,
  jumpConfirmBps: 500,
  roundingStep: 100,
  showBreakdown: false,
};

/** A 21k / 18k rate this far (bps) from 24k * karat/24 needs a confirmation when entered together. */
export const KARAT_COHERENCE_GATE_BPS = 400;
/** A store may hold at most this many gold products (Ruling B5-13); above it the repricer refuses. */
export const GOLD_CATALOGUE_CAP = 5000;

export async function loadSettings(db: GoldDb, storeId: string): Promise<GoldSettings> {
  const row = await db.goldRateSettings.findUnique({
    where: { storeId },
    select: {
      enabled: true,
      feedEnabled: true,
      feedPremiumBps: true,
      maxAgeMinutes: true,
      jumpConfirmBps: true,
      roundingStep: true,
      showBreakdown: true,
    },
  });
  return row
    ? { ...row, roundingStep: row.roundingStep as GoldRoundingStep }
    : { ...DEFAULT_GOLD_SETTINGS };
}

/**
 * The applied rate per karat, read FRESH from the database. `lock: 'update'` is the rate writer's
 * (`FOR UPDATE`), `lock: 'share'` is checkout's (`FOR SHARE`, Ruling B5-17): the two serialise, so a
 * rate write that commits between a checkout's pre-check and its money transaction is seen as a
 * changed rate id, never as an order at the old rate.
 */
export async function loadCurrentRates(
  db: GoldDb,
  storeId: string,
  karats: readonly GoldKarat[] = GOLD_KARATS,
  opts: { lock?: 'share' | 'update' } = {}
): Promise<Map<GoldKarat, CurrentRate>> {
  const wanted = [...new Set(karats)];
  const out = new Map<GoldKarat, CurrentRate>();
  if (wanted.length === 0) return out;
  type Row = { karat: number; rate_id: string; rate_per_gram: number; applied_at: Date };
  const lock =
    opts.lock === 'update'
      ? Prisma.sql`FOR UPDATE`
      : opts.lock === 'share'
        ? Prisma.sql`FOR SHARE`
        : Prisma.empty;
  const rows = await db.$queryRaw<Row[]>(
    Prisma.sql`SELECT karat, rate_id, rate_per_gram, applied_at
                 FROM gold_rates_current
                WHERE store_id = ${storeId} AND karat = ANY(${wanted}::smallint[])
                ORDER BY karat ${lock}`
  );
  for (const r of rows)
    out.set(r.karat as GoldKarat, {
      karat: r.karat as GoldKarat,
      rateId: r.rate_id,
      ratePerGram: r.rate_per_gram,
      appliedAt: r.applied_at,
    });
  return out;
}

/** Whole minutes since a rate was applied (never negative: a clock skew reads as fresh, not stale). */
export function rateAgeMinutes(appliedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - appliedAt.getTime()) / 60_000));
}

/** A rate is stale from the moment its age EQUALS the max age (Ruling B5-16: `maxAge - 1 min` still sells). */
export function isRateStale(appliedAt: Date, maxAgeMinutes: number, now: Date): boolean {
  return rateAgeMinutes(appliedAt, now) >= maxAgeMinutes;
}

export const GOLD_STALE_MESSAGE_EN =
  "We can't take orders for this piece right now because today's gold rate hasn't been updated. Please try again later or contact the store.";

/**
 * Fail closed: every karat a priced line needs must have a rate, and it must be inside the store's max
 * age. Throws 409 GOLD_RATE_STALE (a missing rate is the same condition: there is no price to charge).
 */
export function assertRatesFresh(
  rates: ReadonlyMap<GoldKarat, CurrentRate>,
  required: readonly GoldKarat[],
  settings: Pick<GoldSettings, 'maxAgeMinutes'>,
  now: Date
): void {
  const stale: Array<{ karat: GoldKarat; ageMinutes: number | null }> = [];
  for (const karat of new Set(required)) {
    const rate = rates.get(karat);
    if (!rate) stale.push({ karat, ageMinutes: null });
    else if (isRateStale(rate.appliedAt, settings.maxAgeMinutes, now))
      stale.push({ karat, ageMinutes: rateAgeMinutes(rate.appliedAt, now) });
  }
  if (stale.length === 0) return;
  throw new AppError(409, 'GOLD_RATE_STALE', GOLD_STALE_MESSAGE_EN, {
    messageAr:
      'مش هنقدر نكمّل الطلب دلوقتي لأن سعر الدهب لسه مستني تحديث النهارده. جرّب تاني بعد شوية أو كلّم المحل.',
    karats: stale,
    maxAgeMinutes: settings.maxAgeMinutes,
  });
}

// ---------------------------------------------------------------------------
// The order gate (Task 12; Rulings B5-17, B5-18)
// ---------------------------------------------------------------------------

/** One order line the gate judges. `key` is whatever the caller indexes its lines by (the cart item id). */
export interface GoldGateLine {
  key: string;
  productId: string;
  variantId: string | null;
  /** The materialised BASE unit price the caller is about to charge from (before PriceResolver). */
  materialisedUnitPrice: number;
  /** What the shopper was shown when the line was added (`cart_items.quoted_unit_price`); null = none. */
  quotedUnitPrice: number | null;
}

export interface GoldGateResult {
  /** Snapshots by line key, for the gold lines only. */
  snapshots: Map<string, GoldLineSnapshot>;
  /** The rate row each karat was priced from: re-checked inside the money transaction. */
  rateIds: Map<GoldKarat, string>;
}

const productGoldSelect = {
  id: true,
  pricingMode: true,
  goldKarat: true,
  goldWeightMg: true,
  makingChargeType: true,
  makingChargeValue: true,
  goldMarginBps: true,
} as const;

const variantGoldSelect = {
  id: true,
  productId: true,
  pricingMode: true,
  goldKarat: true,
  goldWeightMg: true,
  makingChargeType: true,
  makingChargeValue: true,
  goldMarginBps: true,
} as const;

/** The spec a line is priced by, or null when it is a fixed-price line. Pure given the two rows. */
export function lineGoldSpec(
  product: {
    pricingMode: string;
    goldKarat: number | null;
    goldWeightMg: number | null;
    makingChargeType: string | null;
    makingChargeValue: number | null;
    goldMarginBps: number;
  },
  variant: {
    pricingMode: string | null;
    goldKarat: number | null;
    goldWeightMg: number | null;
    makingChargeType: string | null;
    makingChargeValue: number | null;
    goldMarginBps: number | null;
  } | null
): GoldPriceSpec | null {
  return resolveVariantGoldSpec(
    {
      pricingMode: product.pricingMode as 'fixed' | 'gold_rate',
      karat: product.goldKarat,
      weightMg: product.goldWeightMg,
      makingChargeType: product.makingChargeType as MakingChargeType | null,
      makingChargeValue: product.makingChargeValue,
      marginBps: product.goldMarginBps,
    },
    {
      pricingMode: (variant?.pricingMode ?? null) as 'fixed' | 'gold_rate' | null,
      karat: variant?.goldKarat ?? null,
      weightMg: variant?.goldWeightMg ?? null,
      makingChargeType: (variant?.makingChargeType ?? null) as MakingChargeType | null,
      makingChargeValue: variant?.makingChargeValue ?? null,
      marginBps: variant?.goldMarginBps ?? null,
    }
  );
}

/**
 * THE gate every order path runs (Ruling B5-17): `OrderService.create` (the shopper and the MCP agent
 * checkout), `OrderService.createAdminOrder` and the payment-link draft order. For every gold line:
 *
 *  1. the rate for its karat must exist and be inside the store's max age, else 409 GOLD_RATE_STALE
 *     (the store's fixed-price lines are never touched: the gate is per gold line, not per store);
 *  2. the price is RECOMPUTED with `computeGoldUnitPrice` from the stored spec and the CURRENT rate and
 *     must equal the materialised price, else 409 GOLD_PRICE_DRIFT plus a P1 (that is a repricer bug,
 *     and nothing is ever charged a guessed price);
 *  3. with `requireQuote`, it must equal the price the shopper was shown, else 409 PRICE_CHANGED with
 *     the old and new prices (the checkout shows "السعر اتحدّث" and asks for "متابعة").
 *
 * With `lock: 'share'` (inside `withMoneyTx`) the current-rate rows are read `FOR SHARE`, which queues
 * behind a rate write's `FOR UPDATE`: a rate that committed between the pre-check and the money
 * transaction is seen as a changed rate id by {@link assertSameRates}, never as an order at the old
 * rate.
 */
export async function assertGoldLinesPriceable(
  db: Prisma.TransactionClient,
  storeId: string,
  lines: readonly GoldGateLine[],
  opts: { requireQuote: boolean; lock?: 'share'; now?: Date }
): Promise<GoldGateResult> {
  const out: GoldGateResult = { snapshots: new Map(), rateIds: new Map() };
  if (lines.length === 0) return out;
  const productIds = [...new Set(lines.map(l => l.productId))];
  const variantIds = [...new Set(lines.map(l => l.variantId).filter((v): v is string => !!v))];
  const [products, variants] = await Promise.all([
    db.product.findMany({ where: { id: { in: productIds }, storeId }, select: productGoldSelect }),
    variantIds.length > 0
      ? db.productVariant.findMany({
          where: { id: { in: variantIds }, product: { storeId } },
          select: variantGoldSelect,
        })
      : Promise.resolve(
          [] as Array<Prisma.ProductVariantGetPayload<{ select: typeof variantGoldSelect }>>
        ),
  ]);
  const productById = new Map(products.map(p => [p.id, p]));
  const variantById = new Map(variants.map(v => [v.id, v]));

  const goldLines: Array<{ line: GoldGateLine; spec: GoldPriceSpec }> = [];
  for (const line of lines) {
    const p = productById.get(line.productId);
    if (!p) continue;
    const v = line.variantId ? (variantById.get(line.variantId) ?? null) : null;
    if (p.pricingMode !== 'gold_rate' && v?.pricingMode !== 'gold_rate') continue;
    const spec = lineGoldSpec(p, v);
    if (spec) goldLines.push({ line, spec });
  }
  if (goldLines.length === 0) return out;

  const now = opts.now ?? new Date();
  const settings = await loadSettings(db, storeId);
  const karats = [...new Set(goldLines.map(g => g.spec.karat))];
  const rates = await loadCurrentRates(db, storeId, karats, { lock: opts.lock });
  assertRatesFresh(rates, karats, settings, now);

  const drift: Array<{
    productId: string;
    variantId: string | null;
    materialised: number;
    expected: number;
  }> = [];
  const changed: Array<{
    productId: string;
    variantId: string | null;
    previous: number;
    current: number;
  }> = [];
  for (const { line, spec } of goldLines) {
    const rate = rates.get(spec.karat)!;
    const expected = computeGoldUnitPrice(spec, rate.ratePerGram, settings.roundingStep).unitPrice;
    if (expected !== line.materialisedUnitPrice) {
      drift.push({
        productId: line.productId,
        variantId: line.variantId,
        materialised: line.materialisedUnitPrice,
        expected,
      });
      continue;
    }
    if (opts.requireQuote && line.quotedUnitPrice !== null && line.quotedUnitPrice !== expected)
      changed.push({
        productId: line.productId,
        variantId: line.variantId,
        previous: line.quotedUnitPrice,
        current: expected,
      });
    out.snapshots.set(line.key, buildGoldSnapshot(spec, rate, settings.roundingStep, expected));
  }
  for (const k of karats) out.rateIds.set(k, rates.get(k)!.rateId);

  if (drift.length > 0) {
    void sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'order.gold-price-drift',
      title: 'Gold price drift: a materialised price differs from the recomputed one',
      body: 'The repricer and the order gate disagree. The order was refused; nothing was charged.',
      context: { storeId, lines: drift.slice(0, 10) },
    }).catch(() => undefined);
    throw new AppError(
      409,
      'GOLD_PRICE_DRIFT',
      'This piece cannot be ordered right now. Please try again in a moment.',
      { messageAr: 'القطعة دي مش هتتطلب دلوقتي. جرّب تاني بعد شوية.', lines: drift.length }
    );
  }
  if (changed.length > 0)
    throw new AppError(
      409,
      'PRICE_CHANGED',
      'The gold rate changed since you added this piece. The new price is shown.',
      {
        messageAr: 'سعر الدهب اتغيّر من ساعة ما ضفت القطعة للسلة، والسعر الجديد ظاهر قدامك.',
        lines: changed,
      }
    );
  return out;
}

/**
 * Inside the money transaction: the gold rate rows an order was priced from must still be the current
 * ones (read `FOR SHARE`, which waits for any rate write in flight). A rate that moved in between is
 * `PRICE_CHANGED`, never an order at the old rate (Ruling B5-17).
 */
export async function assertSameRates(
  db: Prisma.TransactionClient,
  storeId: string,
  priced: ReadonlyMap<GoldKarat, string>
): Promise<void> {
  if (priced.size === 0) return;
  const now = await loadCurrentRates(db, storeId, [...priced.keys()], { lock: 'share' });
  for (const [karat, rateId] of priced)
    if (now.get(karat)?.rateId !== rateId)
      throw new AppError(
        409,
        'PRICE_CHANGED',
        'The gold rate changed while your order was being placed. The new price is shown.',
        { messageAr: 'سعر الدهب اتغيّر وإنت بتكمّل الطلب. السعر الجديد ظاهر قدامك.', karat }
      );
}

/** The `order_items.gold_snapshot` for one line (Zod-valid by construction). */
export function buildGoldSnapshot(
  spec: GoldPriceSpec,
  rate: CurrentRate,
  roundingStep: GoldRoundingStep,
  unitPrice: number
): GoldLineSnapshot {
  return {
    v: 1,
    karat: spec.karat,
    weightMg: spec.weightMg,
    ratePerGram: rate.ratePerGram,
    rateId: rate.rateId,
    rateAppliedAt: rate.appliedAt.toISOString(),
    makingChargeType: spec.makingChargeType,
    makingChargeValue: spec.makingChargeValue,
    marginBps: spec.marginBps,
    roundingStep,
    unitPrice,
  };
}

/**
 * The quote a cart line stores when it is CREATED: the server's current base price for a gold line,
 * nothing for a fixed one. Never client-supplied (Ruling B5-17). One query for many lines.
 */
export async function goldQuotesForLines(
  db: Prisma.TransactionClient,
  storeId: string,
  lines: ReadonlyArray<{ productId: string; variantId: string | null }>
): Promise<Map<string, { quotedUnitPrice: number; quotedAt: Date }>> {
  const out = new Map<string, { quotedUnitPrice: number; quotedAt: Date }>();
  if (lines.length === 0) return out;
  const productIds = [...new Set(lines.map(l => l.productId))];
  const variantIds = [...new Set(lines.map(l => l.variantId).filter((v): v is string => !!v))];
  const products = await db.product.findMany({
    where: { id: { in: productIds }, storeId },
    select: { id: true, price: true, pricingMode: true },
  });
  const variants = variantIds.length
    ? await db.productVariant.findMany({
        where: { id: { in: variantIds }, product: { storeId } },
        select: { id: true, price: true, pricingMode: true },
      })
    : [];
  const pById = new Map(products.map(p => [p.id, p]));
  const vById = new Map(variants.map(v => [v.id, v]));
  const at = new Date();
  for (const l of lines) {
    const p = pById.get(l.productId);
    const v = l.variantId ? vById.get(l.variantId) : undefined;
    const gold = (v?.pricingMode ?? p?.pricingMode) === 'gold_rate';
    if (!p || !gold) continue;
    out.set(goldQuoteKey(l.productId, l.variantId), {
      quotedUnitPrice: v?.price ?? p.price,
      quotedAt: at,
    });
  }
  return out;
}

export const goldQuoteKey = (productId: string, variantId: string | null): string =>
  `${productId}|${variantId ?? ''}`;
