// DO port of the gold-rate WRITE path (apps/api/src/services/gold-rate/gold-rate.service.ts `applyRates` +
// repricer.ts `repriceStore`). One `transactionSync`: jump gate -> history row -> current row -> the repricer with
// `do_flags.gold_reprice = 1` -> flag cleared. Checkout (`placeOrder`) reads `gold_rates_current` and writes the order
// in ANOTHER single `transactionSync` on the same DO thread, so every order is priced with the rate that was current at
// its commit: a rate write either lands before the checkout section (the order uses the new rate) or after it (the
// order keeps the old one); there is no interleaving (Ruling B5-17 share/exclusive pair collapses to "same thread").
// Money is integer piastres. The audit row is the Worker's job (no audit table here), after the commit.
import {
  GOLD_KARATS,
  computeGoldUnitPrice,
  GOLD_ROUNDING_STEPS,
  loadCurrentRates,
  loadGoldSettings,
  resolveVariantGoldSpec,
} from './gold';
import type { GoldKarat, GoldPriceSpec, GoldRoundingStep } from './gold';
import { MoneyError, type SyncSql } from './sync-sql';
import { goldRateJumpBps, karatCoherenceBps } from '../../../shared/src/commerce/gold-price';

export const KARAT_COHERENCE_GATE_BPS = 400;
export const GOLD_CATALOGUE_CAP = 5000;
const RATE_MIN = 10_000;
const RATE_MAX = 10_000_000;

export type RateActor =
  | { userId: string }
  | { feed: Record<string, unknown>; forcePending?: boolean; skipJumpGate?: boolean };
export interface RateRow {
  id: string;
  karat: GoldKarat;
  ratePerGram: number;
  source: 'manual' | 'feed';
  status: 'applied' | 'pending' | 'rejected';
  jumpBps: number | null;
}
export interface ApplyRatesInput {
  rates: Array<{ karat: GoldKarat; ratePerGram: number }>;
  /** a manual rate over the jump / coherence gate needs this, else 409 GOLD_RATE_CONFIRM_REQUIRED */
  confirm?: boolean;
}
interface RateLookup {
  get(k: GoldKarat): { id: string; ratePerGram: number } | undefined;
}

const err = (code: string, message: string, status = 409, meta?: Record<string, unknown>) =>
  new MoneyError(code, message, status, meta);
const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const sqlNullable = <T>(v: T | null | undefined) => (v === undefined ? null : v);

function setFlag(db: SyncSql, on: boolean): void {
  db.run(
    `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
    [on ? 1 : 0]
  );
}

/** Write 1..3 rates and reprice the catalogue, atomically. Throws leave NOTHING behind. */
export function applyGoldRates(
  db: SyncSql,
  storeId: string,
  input: ApplyRatesInput,
  actor: RateActor,
  opts: { now?: number; newId?: () => string } = {}
): { applied: RateRow[]; pending: RateRow[]; repriced: number } {
  if (!storeId) throw err('STORE_REQUIRED', 'storeId is required', 500);
  const rates = input?.rates;
  if (!Array.isArray(rates) || rates.length < 1 || rates.length > 3)
    throw err('GOLD_RATE_INVALID', 'send 1 to 3 rates', 400);
  const seen = new Set<number>();
  for (const r of rates) {
    if (!(GOLD_KARATS as readonly number[]).includes(r?.karat) || seen.has(r.karat))
      throw err('GOLD_RATE_INVALID', 'karat must be 24, 21 or 18, once each', 400);
    seen.add(r.karat);
    if (!isInt(r.ratePerGram, RATE_MIN, RATE_MAX))
      throw err('GOLD_RATE_INVALID', 'ratePerGram out of range', 400);
  }
  const isFeed = 'feed' in actor;
  const now = opts.now ?? Date.now();
  const newId = opts.newId ?? (() => crypto.randomUUID());

  return db.transactionSync(() => {
    const settings = loadGoldSettings(db, storeId);
    const current = loadCurrentRates(db, storeId, GOLD_KARATS);
    const entered24 = rates.find(r => r.karat === 24)?.ratePerGram;
    const verdicts = rates.map(r => {
      const prev = current.get(r.karat)?.ratePerGram;
      const jumpBps = prev ? goldRateJumpBps(prev, r.ratePerGram) : null;
      const coherenceBps =
        entered24 && r.karat !== 24
          ? karatCoherenceBps(entered24, r.ratePerGram, r.karat as 21 | 18)
          : null;
      const over =
        (jumpBps !== null && jumpBps > settings.jumpConfirmBps) ||
        (coherenceBps !== null && coherenceBps > KARAT_COHERENCE_GATE_BPS);
      return { ...r, jumpBps, coherenceBps, over };
    });
    const offending = verdicts.filter(v => v.over);
    if (offending.length > 0 && !isFeed && !input.confirm)
      throw err(
        'GOLD_RATE_CONFIRM_REQUIRED',
        'This rate is far from the last one. Confirm it to continue.',
        409,
        {
          karat: offending[0].karat,
          jumpBps: offending[0].jumpBps,
          coherenceBps: offending[0].coherenceBps,
          items: offending.map(o => ({
            karat: o.karat,
            jumpBps: o.jumpBps,
            coherenceBps: o.coherenceBps,
          })),
        }
      );

    const applied: RateRow[] = [];
    const pending: RateRow[] = [];
    const newRates = new Map<GoldKarat, { id: string; ratePerGram: number }>();
    for (const v of verdicts) {
      const a = actor as { forcePending?: boolean; skipJumpGate?: boolean };
      const isPending = isFeed && ((v.over && a.skipJumpGate !== true) || a.forcePending === true);
      if (isPending)
        db.run(
          `UPDATE gold_rates SET status = 'rejected', decided_by = 'system:superseded' WHERE store_id = ? AND karat = ? AND status = 'pending'`,
          [storeId, v.karat]
        );
      const id = newId();
      db.run(
        `INSERT INTO gold_rates (id, store_id, karat, rate_per_gram, source, status, jump_bps, feed_reference, created_by, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          storeId,
          v.karat,
          v.ratePerGram,
          isFeed ? 'feed' : 'manual',
          isPending ? 'pending' : 'applied',
          v.jumpBps,
          isFeed ? JSON.stringify((actor as { feed: unknown }).feed) : null,
          'userId' in actor ? actor.userId : null,
          now,
          isPending ? null : now,
        ]
      );
      const row: RateRow = {
        id,
        karat: v.karat,
        ratePerGram: v.ratePerGram,
        source: isFeed ? 'feed' : 'manual',
        status: isPending ? 'pending' : 'applied',
        jumpBps: v.jumpBps,
      };
      if (isPending) {
        pending.push(row);
        continue;
      }
      applied.push(row);
      newRates.set(v.karat, { id, ratePerGram: v.ratePerGram });
      db.run(
        `INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (store_id, karat) DO UPDATE SET rate_id = excluded.rate_id, rate_per_gram = excluded.rate_per_gram, applied_at = excluded.applied_at`,
        [storeId, v.karat, id, v.ratePerGram, now]
      );
    }
    let repriced = 0;
    if (newRates.size > 0) {
      const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
      for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
      for (const [k, r] of newRates) lookup.set(k, r);
      setFlag(db, true);
      try {
        repriced = repriceGoldStore(
          db,
          storeId,
          [...newRates.keys()],
          lookup,
          settings.roundingStep,
          now
        );
      } finally {
        setFlag(db, false);
      }
    }
    return { applied, pending, repriced };
  });
}

interface Plan {
  products: Array<{ id: string; price: number; rateId: string | null }>;
  variants: Array<{ id: string; price: number; rateId: string | null }>;
}

/** Re-price every gold product whose resolved karat is in `karats`. Runs inside the caller's section. */
export function repriceGoldStore(
  db: SyncSql,
  storeId: string,
  karats: readonly GoldKarat[] | null,
  rates: RateLookup,
  step: GoldRoundingStep,
  now: number,
  onlyProductId?: string
): number {
  const prods = db.all(
    `SELECT id, price, gold_rate_id, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps
       FROM products WHERE store_id = ?1 AND pricing_mode = 'gold_rate' AND deleted_at IS NULL AND (?2 IS NULL OR id = ?2) LIMIT ?3`,
    [storeId, onlyProductId ?? null, GOLD_CATALOGUE_CAP + 1]
  );
  if (prods.length > GOLD_CATALOGUE_CAP)
    throw err(
      'GOLD_CATALOGUE_TOO_LARGE',
      `A store can hold at most ${GOLD_CATALOGUE_CAP} gold-priced products`
    );
  const affected = karats ? new Set<number>(karats) : null;
  const plan: Plan = { products: [], variants: [] };
  for (const p of prods) {
    const pf = {
      pricingMode: 'gold_rate' as const,
      karat: nn(p.gold_karat),
      weightMg: nn(p.gold_weight_mg),
      makingChargeType: (p.making_charge_type ?? null) as GoldPriceSpec['makingChargeType'] | null,
      makingChargeValue: nn(p.making_charge_value),
      marginBps: Number(p.gold_margin_bps ?? 0),
    };
    const pPrice = Number(p.price);
    const pRate = (p.gold_rate_id ?? null) as string | null;
    const priceOf = (spec: GoldPriceSpec): { price: number; rateId: string } | null => {
      if (affected && !affected.has(spec.karat)) return null;
      const rate = rates.get(spec.karat);
      if (!rate)
        throw err('GOLD_RATE_MISSING', `No ${spec.karat}k rate has been set for this store`, 409, {
          karat: spec.karat,
        });
      return {
        price: computeGoldUnitPrice(spec, rate.ratePerGram, step).unitPrice,
        rateId: rate.id,
      };
    };
    const vrows = db.all(
      `SELECT id, price, gold_rate_id, is_active, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps
         FROM product_variants WHERE product_id = ?`,
      [p.id]
    );
    if (vrows.length === 0) {
      const spec = resolveVariantGoldSpec(pf, {
        pricingMode: null,
        karat: null,
        weightMg: null,
        makingChargeType: null,
        makingChargeValue: null,
        marginBps: null,
      })!;
      const r = priceOf(spec);
      if (r && (r.price !== pPrice || r.rateId !== pRate))
        plan.products.push({ id: p.id as string, price: r.price, rateId: r.rateId });
      continue;
    }
    const effective: Array<{ price: number; active: boolean }> = [];
    for (const v of vrows) {
      const active = v.is_active === 1;
      const spec = resolveVariantGoldSpec(pf, {
        pricingMode: (v.pricing_mode ?? null) as 'fixed' | 'gold_rate' | null,
        karat: nn(v.gold_karat),
        weightMg: nn(v.gold_weight_mg),
        makingChargeType: (v.making_charge_type ?? null) as
          | GoldPriceSpec['makingChargeType']
          | null,
        makingChargeValue: nn(v.making_charge_value),
        marginBps: nn(v.gold_margin_bps),
      });
      const vPrice = nn(v.price);
      if (!spec) {
        if (vPrice != null) effective.push({ price: vPrice, active });
        continue;
      }
      const r = priceOf(spec);
      if (!r) {
        if (vPrice != null) effective.push({ price: vPrice, active });
        continue;
      }
      effective.push({ price: r.price, active });
      if (r.price !== vPrice || r.rateId !== (v.gold_rate_id ?? null))
        plan.variants.push({ id: v.id as string, price: r.price, rateId: r.rateId });
    }
    if (effective.length === 0) continue;
    const pool = effective.some(e => e.active) ? effective.filter(e => e.active) : effective;
    const min = Math.min(...pool.map(e => e.price));
    if (min !== pPrice) plan.products.push({ id: p.id as string, price: min, rateId: null });
  }
  for (const w of plan.products)
    db.run(
      `UPDATE products SET price = ?, gold_rate_id = coalesce(?, gold_rate_id), updated_at = ? WHERE id = ? AND store_id = ?`,
      [w.price, sqlNullable(w.rateId), now, w.id, storeId]
    );
  for (const w of plan.variants)
    db.run(
      `UPDATE product_variants SET price = ?, gold_rate_id = ?, updated_at = ? WHERE id = ? AND product_id IN (SELECT id FROM products WHERE store_id = ?)`,
      [w.price, w.rateId, now, w.id, storeId]
    );
  return plan.products.length + plan.variants.length;
}

/** Confirm or reject a PENDING feed rate. Confirming applies it exactly as typed (current row + reprice), atomically. */
export function decidePendingGoldRate(
  db: SyncSql,
  storeId: string,
  rateId: string,
  decision: 'confirm' | 'reject',
  actor: { userId: string },
  opts: { now?: number } = {}
): { status: 'applied' | 'rejected'; repriced: number } {
  if (!storeId) throw err('STORE_REQUIRED', 'storeId is required', 500);
  if (decision !== 'confirm' && decision !== 'reject')
    throw err('BAD_DECISION', 'confirm or reject', 400);
  const now = opts.now ?? Date.now();
  return db.transactionSync(() => {
    const row = db.all(
      'SELECT id, karat, rate_per_gram, status FROM gold_rates WHERE id = ? AND store_id = ?',
      [rateId, storeId]
    )[0];
    if (!row) throw err('NOT_FOUND', 'Rate not found', 404);
    if (row.status !== 'pending')
      throw err('RATE_NOT_PENDING', 'This rate has already been decided');
    if (decision === 'reject') {
      db.run(
        "UPDATE gold_rates SET status = 'rejected', decided_by = ? WHERE id = ? AND store_id = ? AND status = 'pending'",
        [actor.userId, rateId, storeId]
      );
      return { status: 'rejected' as const, repriced: 0 };
    }
    const settings = loadGoldSettings(db, storeId);
    const current = loadCurrentRates(db, storeId, GOLD_KARATS);
    const karat = row.karat as GoldKarat;
    db.run(
      "UPDATE gold_rates SET status = 'applied', decided_by = ?, applied_at = ? WHERE id = ? AND store_id = ? AND status = 'pending'",
      [actor.userId, now, rateId, storeId]
    );
    db.run(
      `INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (store_id, karat) DO UPDATE SET rate_id = excluded.rate_id, rate_per_gram = excluded.rate_per_gram, applied_at = excluded.applied_at`,
      [storeId, karat, rateId, row.rate_per_gram, now]
    );
    const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
    for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
    lookup.set(karat, { id: rateId, ratePerGram: Number(row.rate_per_gram) });
    setFlag(db, true);
    try {
      return {
        status: 'applied' as const,
        repriced: repriceGoldStore(db, storeId, [karat], lookup, settings.roundingStep, now),
      };
    } finally {
      setFlag(db, false);
    }
  });
}

export interface GoldSettingsInput {
  enabled: boolean;
  feedEnabled: boolean;
  feedPremiumBps: number;
  maxAgeMinutes: number;
  jumpConfirmBps: number;
  roundingStep: GoldRoundingStep;
  showBreakdown: boolean;
}
/** Save the store's gold settings; a changed rounding step re-prices every gold row in the same section. */
export function updateGoldSettings(
  db: SyncSql,
  storeId: string,
  input: GoldSettingsInput,
  actor: { userId: string },
  opts: { now?: number } = {}
): { repriced: number } {
  if (!storeId) throw err('STORE_REQUIRED', 'storeId is required', 500);
  const bad = (m: string) => err('GOLD_SETTINGS_INVALID', m, 400);
  if (!isInt(input.feedPremiumBps, -1000, 1000)) throw bad('feedPremiumBps');
  if (!isInt(input.maxAgeMinutes, 60, 1560)) throw bad('maxAgeMinutes');
  if (!isInt(input.jumpConfirmBps, 100, 5000)) throw bad('jumpConfirmBps');
  if (!GOLD_ROUNDING_STEPS.includes(input.roundingStep)) throw bad('roundingStep');
  const now = opts.now ?? Date.now();
  return db.transactionSync(() => {
    const before = loadGoldSettings(db, storeId);
    db.run(
      `INSERT INTO gold_rate_settings (store_id, enabled, feed_enabled, feed_premium_bps, max_age_minutes, jump_confirm_bps, rounding_step, show_breakdown, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (store_id) DO UPDATE SET enabled = excluded.enabled, feed_enabled = excluded.feed_enabled,
         feed_premium_bps = excluded.feed_premium_bps, max_age_minutes = excluded.max_age_minutes,
         jump_confirm_bps = excluded.jump_confirm_bps, rounding_step = excluded.rounding_step,
         show_breakdown = excluded.show_breakdown, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [
        storeId,
        input.enabled ? 1 : 0,
        input.feedEnabled ? 1 : 0,
        input.feedPremiumBps,
        input.maxAgeMinutes,
        input.jumpConfirmBps,
        input.roundingStep,
        input.showBreakdown ? 1 : 0,
        actor.userId,
        now,
      ]
    );
    if (before.roundingStep === input.roundingStep) return { repriced: 0 };
    const current = loadCurrentRates(db, storeId, GOLD_KARATS);
    const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
    for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
    setFlag(db, true);
    try {
      return {
        repriced: repriceGoldStore(
          db,
          storeId,
          [...lookup.keys()],
          lookup,
          input.roundingStep,
          now
        ),
      };
    } finally {
      setFlag(db, false);
    }
  });
}

/** Re-price ONE product after a spec or mode edit (every gold row of it, whatever the karat). */
export function repriceGoldProduct(
  db: SyncSql,
  storeId: string,
  productId: string,
  now = Date.now()
): number {
  return db.transactionSync(() => {
    const settings = loadGoldSettings(db, storeId);
    const current = loadCurrentRates(db, storeId, GOLD_KARATS);
    const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
    for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
    setFlag(db, true);
    try {
      return repriceGoldStore(db, storeId, null, lookup, settings.roundingStep, now, productId);
    } finally {
      setFlag(db, false);
    }
  });
}
