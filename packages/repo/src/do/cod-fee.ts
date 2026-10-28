// DO port of the cash-on-delivery fee: `codFeeForOrder` (packages/shared/src/order-tax.ts), `codFeeMinor` /
// `percentOfMinor` (region/index.ts) and `loadCodFeeConfig` / `codFeeConfigFromRow` (cod.provider.ts).
// Fee = fixed part + percentBps of (max(0, subtotal - discount) + max(0, shipping)), half up, never negative:
// no fee-on-fee and no fee-on-VAT (Ruling MONEYB-3). The caller puts the fee in `orders.cod_fee`, in the total and
// in the VAT base (tax.ts `computeOrderAmounts({ codFee })`).
import { MoneyError, type SyncSql } from './sync-sql';
import { mulDivRound } from './tax';

export interface CodFeeConfig {
  /** Fixed part, piastres. */
  fixedFee: number;
  /** Percentage part in basis points (200 = 2%). */
  percentBps: number;
}

const MAX_MONEY = 2_000_000_000;
const bad = (msg: string) => new MoneyError('INVALID_INPUT', msg, 400);

/** The enabled COD config of a store, or null when COD is off / not configured. Port of `loadCodFeeConfig`. */
export function loadCodFeeConfig(db: SyncSql, storeId: string): CodFeeConfig | null {
  if (typeof storeId !== 'string' || !storeId) throw bad('storeId is required');
  const row = db.all(
    `SELECT fixed_fee, settings FROM payment_configs
      WHERE store_id = ? AND provider = 'cod' AND is_enabled = 1 ORDER BY id ASC LIMIT 1`,
    [storeId]
  )[0];
  if (!row) return null;
  let settings: unknown;
  try {
    settings = JSON.parse(typeof row.settings === 'string' ? row.settings : '{}');
  } catch {
    throw new MoneyError('COD_CONFIG_CORRUPT', 'payment_configs.settings is not valid JSON', 500);
  }
  const fixed = Number(row.fixed_fee);
  const bps = Number((settings as { percentBps?: unknown } | null)?.percentBps ?? 0);
  return {
    fixedFee: Number.isFinite(fixed) && fixed > 0 ? Math.round(fixed) : 0,
    percentBps: Number.isFinite(bps) && bps > 0 ? Math.round(bps) : 0,
  };
}

/** Port of `codFeeForOrder` (+ `codFeeMinor`). `cfg` null/undefined means COD is off: fee 0. */
export function codFeeForOrder(
  amounts: { subtotal: number; discount: number; shipping: number },
  cfg: { fixedFee?: number; percentBps?: number } | null | undefined
): number {
  for (const [k, v] of Object.entries(amounts))
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > MAX_MONEY)
      throw bad(`${k} must be an integer number of piastres within +-2,000,000,000`);
  if (!cfg) return 0;
  const base = Math.max(0, amounts.subtotal - amounts.discount) + Math.max(0, amounts.shipping);
  const percentBps = Number.isFinite(cfg.percentBps) ? Number(cfg.percentBps) : 0;
  const fixedMinor = Math.max(0, Math.round(Number(cfg.fixedFee) || 0));
  const pctBps = Math.max(0, Math.round(percentBps));
  const pct = pctBps ? mulDivRound(base, pctBps, 10_000) : 0;
  return Math.max(0, fixedMinor + pct);
}

/** The COD fee frozen on an order: only for `paymentMethod === 'cod'`, read from the store's enabled COD config. */
export function codFeeForCheckout(
  db: SyncSql,
  storeId: string,
  paymentMethod: string | null | undefined,
  amounts: { subtotal: number; discount: number; shipping: number }
): number {
  if (paymentMethod !== 'cod') return 0;
  return codFeeForOrder(amounts, loadCodFeeConfig(db, storeId));
}
