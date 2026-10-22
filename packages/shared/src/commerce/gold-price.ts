/**
 * Gold-rate pricing: the ONE implementation of the price formula (Rulings B5-13, B5-14).
 *
 * Everything is an integer. A rate is piastres per gram, a weight is milligrams, a margin is basis
 * points, a making charge is piastres (fixed) or piastres per gram (per_gram). The arithmetic runs
 * in BigInt from the first multiplication to the last and rounds EXACTLY ONCE, at the end,
 * directly to the store's rounding step. There is no Float, no `toFixed`, and no Number product of
 * two inputs: a single Number intermediate above 2^53 would silently lose piastres (vector E of
 * `tests/unit/gold-price.test.ts` is built to catch it).
 *
 *   metal  = weightMg * ratePerGram                      (piastre*mg/g)
 *   making = fixed ? value * 1000 : weightMg * value     (same unit)
 *   base   = metal + making
 *   num    = base * (10 000 + marginBps)
 *   final  = roundHalfUp(num / (10^7 * step)) * step     (piastres, `step` = 1 | 100 | 500 | 1000)
 *
 * The repricer, the order re-check, the admin preview and the tests all call
 * `computeGoldUnitPrice`; SQL never re-implements it.
 */

export const GOLD_KARATS = [24, 21, 18] as const;
export type GoldKarat = (typeof GOLD_KARATS)[number];
export type MakingChargeType = 'fixed' | 'per_gram';
/** Piastres: 1 = exact, 100 = whole pounds (the default), 500 and 1000 = nearest 5 / 10 pounds. */
export const GOLD_ROUNDING_STEPS = [1, 100, 500, 1000] as const;
export type GoldRoundingStep = (typeof GOLD_ROUNDING_STEPS)[number];
export const GOLD_DEFAULT_ROUNDING_STEP: GoldRoundingStep = 100;

export const GOLD_WEIGHT_MG_MIN = 1;
export const GOLD_WEIGHT_MG_MAX = 1_000_000;
export const GOLD_RATE_MIN = 10_000;
export const GOLD_RATE_MAX = 10_000_000;
export const GOLD_MARGIN_BPS_MIN = -5_000;
export const GOLD_MARGIN_BPS_MAX = 10_000;
export const GOLD_MAKING_VALUE_MAX = 2_147_483_647;
/** Postgres int4: the materialised `price` column. */
export const GOLD_PRICE_MAX = 2_147_483_647;

export interface GoldPriceSpec {
  karat: GoldKarat;
  /** Milligrams, integer 1..1 000 000. */
  weightMg: number;
  makingChargeType: MakingChargeType;
  /** Piastres (fixed) or piastres per gram (per_gram), integer >= 0. */
  makingChargeValue: number;
  /** Basis points, integer -5000..10000. */
  marginBps: number;
}

/** Piastres. `metalValue` / `makingValue` are DISPLAY splits, each rounded half-up independently, never summed into `unitPrice`. */
export interface GoldPriceResult {
  unitPrice: number;
  metalValue: number;
  makingValue: number;
}

export type GoldPriceErrorCode =
  | 'GOLD_SPEC_INVALID'
  | 'GOLD_RATE_INVALID'
  | 'GOLD_PRICE_OUT_OF_RANGE';

export class GoldPriceError extends Error {
  readonly code: GoldPriceErrorCode;
  constructor(code: GoldPriceErrorCode, message: string) {
    super(message);
    this.name = 'GoldPriceError';
    this.code = code;
  }
}

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;

/** `round_half_up(a / b)` for positive BigInts: `floor((2a + b) / (2b))`. */
// BigInt() calls, not `1000n` literals: apps/web and apps/admin compile this source at a target below ES2020.
const N1 = BigInt(1);
const N2 = BigInt(2);
const N1000 = BigInt(1000);
const N10000 = BigInt(10000);
/** Piastre*mg/g -> piastre, times the basis-point scale: the divisor before the rounding step. */
const SCALE = BigInt(10_000_000);

const roundHalfUpDiv = (a: bigint, b: bigint): bigint => (N2 * a + b) / (N2 * b);

function assertSpec(spec: GoldPriceSpec): void {
  if (!spec || typeof spec !== 'object')
    throw new GoldPriceError('GOLD_SPEC_INVALID', 'missing spec');
  if (!(GOLD_KARATS as readonly number[]).includes(spec.karat))
    throw new GoldPriceError(
      'GOLD_SPEC_INVALID',
      `karat ${String(spec.karat)} is not 24, 21 or 18`
    );
  if (!isInt(spec.weightMg, GOLD_WEIGHT_MG_MIN, GOLD_WEIGHT_MG_MAX))
    throw new GoldPriceError('GOLD_SPEC_INVALID', `weightMg ${String(spec.weightMg)} out of range`);
  if (spec.makingChargeType !== 'fixed' && spec.makingChargeType !== 'per_gram')
    throw new GoldPriceError('GOLD_SPEC_INVALID', 'makingChargeType must be fixed or per_gram');
  if (!isInt(spec.makingChargeValue, 0, GOLD_MAKING_VALUE_MAX))
    throw new GoldPriceError(
      'GOLD_SPEC_INVALID',
      `makingChargeValue ${String(spec.makingChargeValue)} out of range`
    );
  if (!isInt(spec.marginBps, GOLD_MARGIN_BPS_MIN, GOLD_MARGIN_BPS_MAX))
    throw new GoldPriceError(
      'GOLD_SPEC_INVALID',
      `marginBps ${String(spec.marginBps)} out of range`
    );
}

/**
 * The unit price of one gold piece, in piastres, from its spec, the rate of its karat and the
 * store's rounding step. Throws `GoldPriceError`; never returns a guess.
 */
export function computeGoldUnitPrice(
  spec: GoldPriceSpec,
  ratePerGram: number,
  roundingStep: GoldRoundingStep
): GoldPriceResult {
  assertSpec(spec);
  if (!isInt(ratePerGram, GOLD_RATE_MIN, GOLD_RATE_MAX))
    throw new GoldPriceError('GOLD_RATE_INVALID', `rate ${String(ratePerGram)} out of range`);
  if (!(GOLD_ROUNDING_STEPS as readonly number[]).includes(roundingStep))
    throw new GoldPriceError(
      'GOLD_SPEC_INVALID',
      `rounding step ${String(roundingStep)} is not allowed`
    );

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
    throw new GoldPriceError(
      'GOLD_PRICE_OUT_OF_RANGE',
      'computed price is outside 1..2147483647 piastres'
    );
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

/**
 * The spec a variant is priced by. A variant's `pricingMode` of `null` inherits the product's; a
 * variant spec field of `null`/undefined inherits the product's field. Returns `null` for a fixed
 * price (the caller then reads the materialised or merchant-set price). Throws `GOLD_SPEC_INVALID`
 * when the row is gold but the merged spec is incomplete or out of range.
 */
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
    // margin defaults to 0 only when NEITHER side states one (the column default)
    makingChargeValue: pick('makingChargeValue'),
    marginBps: pick('marginBps') ?? 0,
  };
  if (
    merged.karat == null ||
    merged.weightMg == null ||
    merged.makingChargeType == null ||
    merged.makingChargeValue == null
  )
    throw new GoldPriceError(
      'GOLD_SPEC_INVALID',
      'a gold-priced row needs karat, weight and making charge'
    );
  const spec = merged as GoldPriceSpec;
  assertSpec(spec);
  return spec;
}

/** `|next - prev| * 10000 / prev` in basis points, integer, rounded UP (a gate never under-reports). */
export function goldRateJumpBps(previous: number, next: number): number {
  if (!isInt(previous, 1, Number.MAX_SAFE_INTEGER) || !isInt(next, 0, Number.MAX_SAFE_INTEGER))
    throw new GoldPriceError('GOLD_RATE_INVALID', 'rates must be positive integers');
  const p = BigInt(previous);
  const diff = BigInt(next) > p ? BigInt(next) - p : p - BigInt(next);
  return Number((diff * N10000 + p - N1) / p);
}

/**
 * How far a 21k / 18k rate sits from `rate24 * karat / 24`, in basis points rounded up. Catches
 * swapped fields when the three karats are entered together (Ruling B5-20).
 */
export function karatCoherenceBps(rate24: number, rateK: number, karat: 21 | 18): number {
  if (!isInt(rate24, 1, Number.MAX_SAFE_INTEGER) || !isInt(rateK, 0, Number.MAX_SAFE_INTEGER))
    throw new GoldPriceError('GOLD_RATE_INVALID', 'rates must be positive integers');
  // expected = rate24 * karat / 24, compared without dividing: |rateK*24 - rate24*karat| / (rate24*karat)
  const k = BigInt(karat);
  const exp = BigInt(rate24) * k;
  const got = BigInt(rateK) * BigInt(24);
  const diff = got > exp ? got - exp : exp - got;
  return Number((diff * N10000 + exp - N1) / exp);
}

/**
 * Grams typed by a person ("12.5", "3.25") to integer milligrams, with integer math. At most TWO
 * decimals (a jeweller's scale), so the result is always a multiple of 10 mg. Anything else is null,
 * never a rounded guess.
 */
export function parseGramsToMg(input: string): number | null {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const mg = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(2, '0')) * 10;
  return mg >= GOLD_WEIGHT_MG_MIN && mg <= GOLD_WEIGHT_MG_MAX ? mg : null;
}

/** Milligrams to the grams string an input shows ("12.50"). */
export function mgToGramsString(mg: number): string {
  // round to hundredths FIRST, then split: 995 mg is 100 hundredths = "1.00", never "0.100"
  const total = Math.round(mg / 10);
  return `${String(Math.floor(total / 100))}.${String(total % 100).padStart(2, '0')}`;
}

/** A margin typed as a percent ("7.5", "-2") to basis points; at most 2 decimals; null otherwise. */
export function parsePercentToBps(input: string): number | null {
  const m = /^(-?)(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  const signed = m[1] ? -bps : bps;
  return signed >= GOLD_MARGIN_BPS_MIN && signed <= GOLD_MARGIN_BPS_MAX ? signed : null;
}

/** Basis points to the percent string an input shows ("7.5"). */
export function bpsToPercentString(bps: number): string {
  const neg = bps < 0;
  const abs = Math.abs(bps);
  const frac = String(abs % 100)
    .padStart(2, '0')
    .replace(/0$/, '');
  return `${neg ? '-' : ''}${String(Math.floor(abs / 100))}${frac === '' || frac === '0' ? '' : `.${frac}`}`;
}
