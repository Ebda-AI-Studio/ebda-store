// DO port of the gold-rate pricing gate at checkout (apps/api/src/services/gold-rate/gate.ts `assertGoldLinesPriceable`
// + `assertSameRates`, packages/shared/src/commerce/gold-price.ts `computeGoldUnitPrice`). Pure and synchronous.
//
// For every line priced by gold rate (product or variant `pricing_mode = 'gold_rate'`) the price is RE-DERIVED from
// the stored spec and the CURRENT applied rate (`gold_rates_current`), never trusted from the caller:
//   1. missing / stale rate           -> 409 GOLD_RATE_STALE (stale from age == max_age_minutes, a missing rate too)
//   2. stored price != recomputed     -> 409 GOLD_PRICE_DRIFT (a repricer bug; nothing is charged a guess)
//   3. caller price / quote != recomputed (quote only with requireQuote) -> 409 PRICE_CHANGED
// Fixed-price lines are never touched. This module only READS: the `do_flags.gold_reprice` flag and the SQLite
// triggers of 0002_invariants.sql guard WRITES to products/variants (the repricer's), so checkout does not set it.
// Dates are epoch ms; money is integer piastres; the BigInt maths is copied from the shared implementation.
import { MoneyError, type SyncSql } from './sync-sql';

export type GoldKarat = 24 | 21 | 18;
export type MakingChargeType = 'fixed' | 'per_gram';
export type GoldRoundingStep = 1 | 100 | 500 | 1000;

export interface GoldPriceSpec {
  karat: GoldKarat;
  weightMg: number;
  makingChargeType: MakingChargeType;
  makingChargeValue: number;
  marginBps: number;
}
export interface GoldLineSnapshot {
  v: 1;
  karat: GoldKarat;
  weightMg: number;
  ratePerGram: number;
  rateId: string;
  rateAppliedAt: string;
  makingChargeType: MakingChargeType;
  makingChargeValue: number;
  marginBps: number;
  roundingStep: GoldRoundingStep;
  unitPrice: number;
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
export interface CurrentRate {
  karat: GoldKarat;
  rateId: string;
  ratePerGram: number;
  /** epoch ms */
  appliedAt: number;
}
export interface GoldGateLine {
  /** What the caller indexes its lines by (the cart item id). */
  key: string;
  productId: string;
  variantId: string | null;
  /** The materialised BASE unit price the caller is about to charge from. */
  materialisedUnitPrice: number;
  /** What the shopper was shown when the line was added; null = none. */
  quotedUnitPrice: number | null;
}
export interface GoldGateResult {
  snapshots: Map<string, GoldLineSnapshot>;
  /** `order_items.gold_snapshot` JSON text per line key (valid JSON object, ready to store). */
  snapshotJson: Map<string, string>;
  /** Per-line re-derived unit price (the price the order must use for that line). */
  unitPrices: Map<string, number>;
  rateIds: Map<GoldKarat, string>;
  lines: Array<{ productId: string; variantId: string | null; price: number; spec: GoldPriceSpec }>;
  roundingStep: GoldRoundingStep | null;
}

export const GOLD_KARATS: readonly GoldKarat[] = [24, 21, 18];
export const GOLD_ROUNDING_STEPS: readonly number[] = [1, 100, 500, 1000];
export const DEFAULT_GOLD_SETTINGS: GoldSettings = {
  enabled: false,
  feedEnabled: false,
  feedPremiumBps: 0,
  maxAgeMinutes: 1560,
  jumpConfirmBps: 500,
  roundingStep: 100,
  showBreakdown: false,
};
export const GOLD_STALE_MESSAGE_EN =
  "We can't take orders for this piece right now because today's gold rate hasn't been updated. Please try again later or contact the store.";

const GOLD_WEIGHT_MG_MIN = 1;
const GOLD_WEIGHT_MG_MAX = 1_000_000;
const GOLD_RATE_MIN = 10_000;
const GOLD_RATE_MAX = 10_000_000;
const GOLD_MARGIN_BPS_MIN = -5_000;
const GOLD_MARGIN_BPS_MAX = 10_000;
const GOLD_MAKING_VALUE_MAX = 2_147_483_647;
const GOLD_PRICE_MAX = 2_147_483_647;
const MAX_LINES = 500;
const MAX_ID = 200;

const gerr = (code: string, message: string) => new MoneyError(code, message, 500);
const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;

const N1 = BigInt(1);
const N2 = BigInt(2);
const N1000 = BigInt(1000);
const SCALE = BigInt(10_000_000);
const roundHalfUpDiv = (a: bigint, b: bigint): bigint => (N2 * a + b) / (N2 * b);

function assertSpec(spec: GoldPriceSpec): void {
  if (!spec || typeof spec !== 'object') throw gerr('GOLD_SPEC_INVALID', 'missing spec');
  if (!(GOLD_KARATS as readonly number[]).includes(spec.karat))
    throw gerr('GOLD_SPEC_INVALID', `karat ${String(spec.karat)} is not 24, 21 or 18`);
  if (!isInt(spec.weightMg, GOLD_WEIGHT_MG_MIN, GOLD_WEIGHT_MG_MAX))
    throw gerr('GOLD_SPEC_INVALID', `weightMg ${String(spec.weightMg)} out of range`);
  if (spec.makingChargeType !== 'fixed' && spec.makingChargeType !== 'per_gram')
    throw gerr('GOLD_SPEC_INVALID', 'makingChargeType must be fixed or per_gram');
  if (!isInt(spec.makingChargeValue, 0, GOLD_MAKING_VALUE_MAX))
    throw gerr(
      'GOLD_SPEC_INVALID',
      `makingChargeValue ${String(spec.makingChargeValue)} out of range`
    );
  if (!isInt(spec.marginBps, GOLD_MARGIN_BPS_MIN, GOLD_MARGIN_BPS_MAX))
    throw gerr('GOLD_SPEC_INVALID', `marginBps ${String(spec.marginBps)} out of range`);
}

/** Port of `computeGoldUnitPrice`: BigInt maths, ONE half-up rounding directly to the store's step. */
export function computeGoldUnitPrice(
  spec: GoldPriceSpec,
  ratePerGram: number,
  roundingStep: GoldRoundingStep
): { unitPrice: number; metalValue: number; makingValue: number } {
  assertSpec(spec);
  if (!isInt(ratePerGram, GOLD_RATE_MIN, GOLD_RATE_MAX))
    throw gerr('GOLD_RATE_INVALID', `rate ${String(ratePerGram)} out of range`);
  if (!GOLD_ROUNDING_STEPS.includes(roundingStep))
    throw gerr('GOLD_SPEC_INVALID', `rounding step ${String(roundingStep)} is not allowed`);
  const w = BigInt(spec.weightMg);
  const metal = w * BigInt(ratePerGram);
  const making =
    spec.makingChargeType === 'fixed'
      ? BigInt(spec.makingChargeValue) * N1000
      : w * BigInt(spec.makingChargeValue);
  const num = (metal + making) * BigInt(10_000 + spec.marginBps);
  const step = BigInt(roundingStep);
  const final = roundHalfUpDiv(num, SCALE * step) * step;
  if (final < N1 || final > BigInt(GOLD_PRICE_MAX))
    throw gerr('GOLD_PRICE_OUT_OF_RANGE', 'computed price is outside 1..2147483647 piastres');
  return {
    unitPrice: Number(final),
    metalValue: Number(roundHalfUpDiv(metal, N1000)),
    makingValue: Number(roundHalfUpDiv(making, N1000)),
  };
}

type SpecFields = {
  karat?: number | null;
  weightMg?: number | null;
  makingChargeType?: MakingChargeType | null;
  makingChargeValue?: number | null;
  marginBps?: number | null;
};

/** Port of `resolveVariantGoldSpec`: variant fields inherit the product's; null for a fixed price. */
export function resolveVariantGoldSpec(
  product: SpecFields & { pricingMode: 'fixed' | 'gold_rate' },
  variant: SpecFields & { pricingMode: 'fixed' | 'gold_rate' | null }
): GoldPriceSpec | null {
  const mode = variant.pricingMode ?? product.pricingMode;
  if (mode === 'fixed') return null;
  const pick = <K extends keyof SpecFields>(k: K) => variant[k] ?? product[k];
  const merged = {
    karat: pick('karat'),
    weightMg: pick('weightMg'),
    makingChargeType: pick('makingChargeType'),
    makingChargeValue: pick('makingChargeValue'),
    marginBps: pick('marginBps') ?? 0,
  };
  if (
    merged.karat == null ||
    merged.weightMg == null ||
    merged.makingChargeType == null ||
    merged.makingChargeValue == null
  )
    throw gerr('GOLD_SPEC_INVALID', 'a gold-priced row needs karat, weight and making charge');
  const spec = merged as GoldPriceSpec;
  assertSpec(spec);
  return spec;
}

/** Whole minutes since a rate was applied (never negative: clock skew reads as fresh). */
export function rateAgeMinutes(appliedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - appliedAt) / 60_000));
}
/** Stale from the moment the age EQUALS the max age (`maxAge - 1 min` still sells). */
export function isRateStale(appliedAt: number, maxAgeMinutes: number, now: number): boolean {
  return rateAgeMinutes(appliedAt, now) >= maxAgeMinutes;
}

export function loadGoldSettings(db: SyncSql, storeId: string): GoldSettings {
  const r = db.all(
    `SELECT enabled, feed_enabled, feed_premium_bps, max_age_minutes, jump_confirm_bps, rounding_step, show_breakdown
       FROM gold_rate_settings WHERE store_id = ?`,
    [storeId]
  )[0];
  if (!r) return { ...DEFAULT_GOLD_SETTINGS };
  if (
    !isInt(r.max_age_minutes, 60, 1560) ||
    !GOLD_ROUNDING_STEPS.includes(r.rounding_step as number)
  )
    throw gerr('GOLD_SETTINGS_CORRUPT', 'gold_rate_settings holds an out-of-range value');
  return {
    enabled: r.enabled === 1,
    feedEnabled: r.feed_enabled === 1,
    feedPremiumBps: Number(r.feed_premium_bps),
    maxAgeMinutes: r.max_age_minutes,
    jumpConfirmBps: Number(r.jump_confirm_bps),
    roundingStep: r.rounding_step as GoldRoundingStep,
    showBreakdown: r.show_breakdown === 1,
  };
}

/** The applied rate per karat, read fresh (the DO transaction is the lock). */
export function loadCurrentRates(
  db: SyncSql,
  storeId: string,
  karats: readonly GoldKarat[] = GOLD_KARATS
): Map<GoldKarat, CurrentRate> {
  const out = new Map<GoldKarat, CurrentRate>();
  for (const karat of new Set(karats)) {
    const r = db.all(
      `SELECT rate_id, rate_per_gram, applied_at FROM gold_rates_current WHERE store_id = ? AND karat = ?`,
      [storeId, karat]
    )[0];
    if (!r) continue;
    if (
      typeof r.rate_id !== 'string' ||
      !isInt(r.rate_per_gram, 1, Number.MAX_SAFE_INTEGER) ||
      !isInt(r.applied_at, 0, Number.MAX_SAFE_INTEGER)
    )
      throw gerr('GOLD_RATE_INVALID', 'gold_rates_current holds a malformed row');
    out.set(karat, {
      karat,
      rateId: r.rate_id,
      ratePerGram: r.rate_per_gram,
      appliedAt: r.applied_at,
    });
  }
  return out;
}

/** Fail closed: every needed karat must have a rate inside the store's max age, else 409 GOLD_RATE_STALE. */
export function assertRatesFresh(
  rates: ReadonlyMap<GoldKarat, CurrentRate>,
  required: readonly GoldKarat[],
  settings: Pick<GoldSettings, 'maxAgeMinutes'>,
  now: number
): void {
  const stale: Array<{ karat: GoldKarat; ageMinutes: number | null }> = [];
  for (const karat of new Set(required)) {
    const rate = rates.get(karat);
    if (!rate) stale.push({ karat, ageMinutes: null });
    else if (isRateStale(rate.appliedAt, settings.maxAgeMinutes, now))
      stale.push({ karat, ageMinutes: rateAgeMinutes(rate.appliedAt, now) });
  }
  if (stale.length === 0) return;
  throw new MoneyError('GOLD_RATE_STALE', GOLD_STALE_MESSAGE_EN, 409, {
    messageAr:
      'مش هنقدر نكمّل الطلب دلوقتي لأن سعر الدهب لسه مستني تحديث النهارده. جرّب تاني بعد شوية أو كلّم المحل.',
    karats: stale,
    maxAgeMinutes: settings.maxAgeMinutes,
  });
}

/** The `order_items.gold_snapshot` for one line. */
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
    rateAppliedAt: new Date(rate.appliedAt).toISOString(),
    makingChargeType: spec.makingChargeType,
    makingChargeValue: spec.makingChargeValue,
    marginBps: spec.marginBps,
    roundingStep,
    unitPrice,
  };
}

type PRow = {
  id: string;
  price: number;
  pricingMode: 'fixed' | 'gold_rate';
  goldKarat: number | null;
  goldWeightMg: number | null;
  makingChargeType: MakingChargeType | null;
  makingChargeValue: number | null;
  goldMarginBps: number;
};
type VRow = {
  price: number | null;
  pricingMode: 'fixed' | 'gold_rate' | null;
  goldKarat: number | null;
  goldWeightMg: number | null;
  makingChargeType: MakingChargeType | null;
  makingChargeValue: number | null;
  goldMarginBps: number | null;
};

const onull = (v: unknown): number | null => (v === null || v === undefined ? null : (v as number));

function readState(db: SyncSql, storeId: string, lines: readonly GoldGateLine[]) {
  const goldLines: Array<{ line: GoldGateLine; spec: GoldPriceSpec; dbPrice: number }> = [];
  for (const line of lines) {
    const pr = db.all(
      `SELECT id, price, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps
         FROM products WHERE id = ? AND store_id = ?`,
      [line.productId, storeId]
    )[0];
    if (!pr) continue;
    const p: PRow = {
      id: pr.id as string,
      price: pr.price as number,
      pricingMode: pr.pricing_mode as PRow['pricingMode'],
      goldKarat: onull(pr.gold_karat),
      goldWeightMg: onull(pr.gold_weight_mg),
      makingChargeType: (pr.making_charge_type as MakingChargeType | null) ?? null,
      makingChargeValue: onull(pr.making_charge_value),
      goldMarginBps: (pr.gold_margin_bps as number) ?? 0,
    };
    let v: VRow | null = null;
    if (line.variantId) {
      const vr = db.all(
        `SELECT v.price, v.pricing_mode, v.gold_karat, v.gold_weight_mg, v.making_charge_type, v.making_charge_value, v.gold_margin_bps
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.id = ? AND p.store_id = ?`,
        [line.variantId, storeId]
      )[0];
      if (vr)
        v = {
          price: onull(vr.price),
          pricingMode: (vr.pricing_mode as VRow['pricingMode']) ?? null,
          goldKarat: onull(vr.gold_karat),
          goldWeightMg: onull(vr.gold_weight_mg),
          makingChargeType: (vr.making_charge_type as MakingChargeType | null) ?? null,
          makingChargeValue: onull(vr.making_charge_value),
          goldMarginBps: onull(vr.gold_margin_bps),
        };
    }
    if (p.pricingMode !== 'gold_rate' && v?.pricingMode !== 'gold_rate') continue;
    const spec = resolveVariantGoldSpec(
      {
        pricingMode: p.pricingMode,
        karat: p.goldKarat,
        weightMg: p.goldWeightMg,
        makingChargeType: p.makingChargeType,
        makingChargeValue: p.makingChargeValue,
        marginBps: p.goldMarginBps,
      },
      {
        pricingMode: v?.pricingMode ?? null,
        karat: v?.goldKarat ?? null,
        weightMg: v?.goldWeightMg ?? null,
        makingChargeType: v?.makingChargeType ?? null,
        makingChargeValue: v?.makingChargeValue ?? null,
        marginBps: v?.goldMarginBps ?? null,
      }
    );
    if (spec) goldLines.push({ line, spec, dbPrice: v?.price ?? p.price });
  }
  const settings =
    goldLines.length > 0 ? loadGoldSettings(db, storeId) : { ...DEFAULT_GOLD_SETTINGS };
  const karats = [...new Set(goldLines.map(g => g.spec.karat))];
  const rates =
    goldLines.length > 0
      ? loadCurrentRates(db, storeId, karats)
      : new Map<GoldKarat, CurrentRate>();
  return { goldLines, settings, karats, rates };
}

function validateLines(storeId: string, lines: readonly GoldGateLine[]): void {
  const bad = (m: string) => new MoneyError('INVALID_INPUT', m, 400);
  if (typeof storeId !== 'string' || !storeId) throw bad('storeId is required');
  if (!Array.isArray(lines) || lines.length > MAX_LINES)
    throw bad(`lines must be a list of at most ${MAX_LINES}`);
  for (const l of lines) {
    const idOk = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= MAX_ID;
    if (!l || !idOk(l.key) || !idOk(l.productId) || !(l.variantId === null || idOk(l.variantId)))
      throw bad('each line needs a key, a productId and a variantId (or null)');
    if (!isInt(l.materialisedUnitPrice, 0, GOLD_PRICE_MAX))
      throw bad('materialisedUnitPrice must be integer piastres');
    if (!(l.quotedUnitPrice === null || isInt(l.quotedUnitPrice, 0, GOLD_PRICE_MAX)))
      throw bad('quotedUnitPrice must be integer piastres or null');
  }
}

/**
 * THE checkout gate (port of `assertGoldLinesPriceable`). Runs inside the checkout transaction, so the rates it
 * reads cannot move before the order commits (this replaces `FOR SHARE` + `assertSameRates`; the Postgres re-read on
 * drift is dropped for the same reason: nothing can commit between two reads of one synchronous transaction).
 * `onDrift` lets the caller raise the P1 alert the Postgres path sends (no I/O here).
 */
export function assertGoldLinesPriceable(
  db: SyncSql,
  storeId: string,
  lines: readonly GoldGateLine[],
  opts: {
    requireQuote: boolean;
    /** epoch ms; defaults to Date.now() */
    now?: number;
    onDrift?: (
      lines: Array<{
        productId: string;
        variantId: string | null;
        materialised: number;
        expected: number;
      }>
    ) => void;
  }
): GoldGateResult {
  validateLines(storeId, lines);
  const out: GoldGateResult = {
    snapshots: new Map(),
    snapshotJson: new Map(),
    unitPrices: new Map(),
    rateIds: new Map(),
    lines: [],
    roundingStep: null,
  };
  if (lines.length === 0) return out;
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new MoneyError('INVALID_INPUT', 'now must be epoch milliseconds', 400);

  const st = readState(db, storeId, lines);
  if (st.goldLines.length === 0) return out;
  assertRatesFresh(st.rates, st.karats, st.settings, now);
  const priced = st.goldLines.map(g => ({
    g,
    expected: computeGoldUnitPrice(
      g.spec,
      st.rates.get(g.spec.karat)!.ratePerGram,
      st.settings.roundingStep
    ).unitPrice,
  }));

  const drift = priced
    .filter(p => p.g.dbPrice !== p.expected)
    .map(p => ({
      productId: p.g.line.productId,
      variantId: p.g.line.variantId,
      materialised: p.g.dbPrice,
      expected: p.expected,
    }));
  if (drift.length > 0) {
    opts.onDrift?.(drift.slice(0, 10));
    throw new MoneyError(
      'GOLD_PRICE_DRIFT',
      'This piece cannot be ordered right now. Please try again in a moment.',
      409,
      {
        messageAr: 'القطعة دي مش هتتطلب دلوقتي. جرّب تاني بعد شوية.',
        lines: drift.length,
      }
    );
  }

  const changed: Array<{
    productId: string;
    variantId: string | null;
    previous: number;
    current: number;
  }> = [];
  for (const { g, expected } of priced) {
    const { line } = g;
    const previous =
      line.materialisedUnitPrice !== expected
        ? line.materialisedUnitPrice
        : opts.requireQuote && line.quotedUnitPrice !== null && line.quotedUnitPrice !== expected
          ? line.quotedUnitPrice
          : null;
    if (previous !== null) {
      changed.push({
        productId: line.productId,
        variantId: line.variantId,
        previous,
        current: expected,
      });
    } else {
      const snap = buildGoldSnapshot(
        g.spec,
        st.rates.get(g.spec.karat)!,
        st.settings.roundingStep,
        expected
      );
      out.snapshots.set(line.key, snap);
      out.snapshotJson.set(line.key, JSON.stringify(snap));
      out.unitPrices.set(line.key, expected);
    }
    out.lines.push({
      productId: line.productId,
      variantId: line.variantId,
      price: expected,
      spec: g.spec,
    });
  }
  for (const k of st.karats) out.rateIds.set(k, st.rates.get(k)!.rateId);
  out.roundingStep = st.settings.roundingStep;
  if (changed.length > 0)
    throw new MoneyError(
      'PRICE_CHANGED',
      'The gold rate changed since you added this piece. The new price is shown.',
      409,
      {
        messageAr: 'سعر الدهب اتغيّر من ساعة ما ضفت القطعة للسلة، والسعر الجديد ظاهر قدامك.',
        lines: changed,
      }
    );
  return out;
}

/**
 * Port of `assertSameRates`: the rate rows (and rounding step / piece specs) an order was priced from must still be
 * the current ones. Inside one DO transaction they always are; kept for a caller that splits pricing from the write.
 */
export function assertSameGoldRates(db: SyncSql, storeId: string, gate: GoldGateResult): void {
  if (gate.rateIds.size === 0) return;
  const changed = (karat?: GoldKarat) =>
    new MoneyError(
      'PRICE_CHANGED',
      'The gold rate changed while your order was being placed. The new price is shown.',
      409,
      {
        messageAr: 'سعر الدهب اتغيّر وإنت بتكمّل الطلب. السعر الجديد ظاهر قدامك.',
        karat,
      }
    );
  const now = loadCurrentRates(db, storeId, [...gate.rateIds.keys()]);
  for (const [karat, rateId] of gate.rateIds)
    if (now.get(karat)?.rateId !== rateId) throw changed(karat);
  const keyed = gate.lines.map(l => ({
    key: l.productId,
    productId: l.productId,
    variantId: l.variantId,
    materialisedUnitPrice: l.price,
    quotedUnitPrice: null,
  }));
  const fresh = readState(db, storeId, keyed);
  if (gate.roundingStep !== null && fresh.settings.roundingStep !== gate.roundingStep)
    throw changed();
  const sig = (productId: string, variantId: string | null, price: number, s: GoldPriceSpec) =>
    `${productId}|${variantId ?? ''}|${price}|${s.karat}|${s.weightMg}|${s.makingChargeType}|${s.makingChargeValue}|${s.marginBps}`;
  const have = new Map<string, number>();
  for (const g of fresh.goldLines) {
    const k = sig(g.line.productId, g.line.variantId, g.dbPrice, g.spec);
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  for (const l of gate.lines)
    if ((have.get(sig(l.productId, l.variantId, l.price, l.spec)) ?? 0) === 0) throw changed();
}
