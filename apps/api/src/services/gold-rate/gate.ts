/**
 * Gold-rate pricing: rate reads, freshness and the typed 409s every order path shares
 * (Rulings B5-16, B5-17, B5-20). The RATE READS ARE NEVER CACHED: the checkout gate, the admin rate
 * page and the repricer read the database directly, because a price is NEVER-stale data.
 */
import { Prisma } from '@ebda/database';
import { GOLD_KARATS, type GoldKarat, type GoldRoundingStep } from '@ebda/shared';
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
