// DO port of ShippingService.calculateShipping (apps/api/src/services/shipping.service.ts) over the StoreDO
// SQLite tables `shipping_zones` and `shipping_area_rates`. Pure and synchronous: no clock, no I/O but `db`.
// Money is integer piastres; booleans are 0/1. Every query is scoped by an explicit store_id.
import { MoneyError, type SyncSql } from './sync-sql';

export interface ShippingQuote {
  matched: boolean;
  storeHasAreaRates: boolean;
  zone: { id: string; name: string; nameAr: string | null } | null;
  shippingCost: number;
  freeShipping: boolean;
  estimatedDays: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

export interface AreaRate {
  area: string;
  governorate: string;
  deliveryFee: number;
  freeShippingThreshold: number | null;
  isActive: boolean;
}

export interface ZoneRow {
  id: string;
  name: string;
  nameAr: string | null;
  areas: string[];
  areasAr: string[];
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDays: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

export interface ResolvedShippingFee {
  shippingCost: number;
  freeShipping: boolean;
  matched: boolean;
  source: 'area-rate' | 'zone' | 'none';
  matchedZone: ZoneRow | null;
}

const MAX_TEXT = 200;
const MAX_MONEY = 2_000_000_000;

/** Same fold as packages/shared `foldPlaceName` (case, Arabic diacritics/tatweel, alef/yeh/teh-marbuta variants, spacing). */
export function foldPlaceName(v: string | null | undefined): string {
  return (v ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Same rule as shared `zoneForAddress` for the {area, governorate} address checkout passes: whole folded names, area first. */
export function zoneForAddress(
  address: { area: string; governorate: string },
  zones: readonly ZoneRow[]
): ZoneRow | null {
  const names = (z: ZoneRow) => [...z.areas, ...z.areasAr].map(foldPlaceName).filter(Boolean);
  for (const value of [address.area, address.governorate].map(foldPlaceName)) {
    if (!value) continue;
    const hit = zones.find(z => names(z).includes(value));
    if (hit) return hit;
  }
  return null;
}

/** Port of `resolveShippingFee`: exact area rate (governorate disambiguates when given), then zone, else nothing. */
export function resolveShippingFee(
  rates: readonly AreaRate[],
  zones: readonly ZoneRow[],
  input: { governorate: string; area: string; orderTotal: number }
): ResolvedShippingFee {
  const { governorate, area, orderTotal } = input;
  const matchedRate = rates
    .filter(r => r.isActive)
    .find(r => {
      if (r.area.toLowerCase() !== area.toLowerCase()) return false;
      if (governorate && governorate.trim() !== '') {
        return r.governorate.toLowerCase() === governorate.toLowerCase();
      }
      return true;
    });
  if (matchedRate) {
    const freeShipping =
      matchedRate.freeShippingThreshold != null && orderTotal >= matchedRate.freeShippingThreshold;
    return {
      shippingCost: freeShipping ? 0 : matchedRate.deliveryFee,
      freeShipping,
      matched: true,
      source: 'area-rate',
      matchedZone: null,
    };
  }
  const zone = zoneForAddress({ area, governorate }, zones);
  if (zone) {
    const freeShipping =
      zone.freeShippingThreshold != null && orderTotal >= zone.freeShippingThreshold;
    return {
      shippingCost: freeShipping ? 0 : zone.deliveryFee,
      freeShipping,
      matched: true,
      source: 'zone',
      matchedZone: zone,
    };
  }
  return {
    shippingCost: 0,
    freeShipping: false,
    matched: false,
    source: 'none',
    matchedZone: null,
  };
}

const bad = (msg: string) => new MoneyError('INVALID_INPUT', msg, 400);
const corrupt = (what: string) => new MoneyError('SHIPPING_CONFIG_CORRUPT', what, 500);

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw corrupt(`${what} is not text`);
  return v;
}
function nint(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw corrupt(`${what} is not a non-negative integer`);
  return v;
}
function names(v: unknown, what: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(str(v, what));
  } catch {
    throw corrupt(`${what} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some(x => typeof x !== 'string'))
    throw corrupt(`${what} is not a list of text`);
  return parsed as string[];
}

export function loadShippingConfig(
  db: SyncSql,
  storeId: string
): { zones: ZoneRow[]; areaRates: AreaRate[] } {
  const zones = db
    .all(
      `SELECT id, name, name_ar, areas, areas_ar, delivery_fee, free_shipping_threshold, estimated_days, estimated_days_min, estimated_days_max
         FROM shipping_zones WHERE store_id = ? AND is_active = 1 ORDER BY position ASC, id ASC`,
      [storeId]
    )
    .map(r => ({
      id: str(r.id, 'zone id'),
      name: str(r.name, 'zone name'),
      nameAr: r.name_ar == null ? null : str(r.name_ar, 'zone name_ar'),
      areas: names(r.areas, 'zone areas'),
      areasAr: names(r.areas_ar, 'zone areas_ar'),
      deliveryFee: nint(r.delivery_fee, 'zone delivery_fee') ?? 0,
      freeShippingThreshold: nint(r.free_shipping_threshold, 'zone free_shipping_threshold'),
      estimatedDays: nint(r.estimated_days, 'zone estimated_days'),
      estimatedDaysMin: nint(r.estimated_days_min, 'zone estimated_days_min'),
      estimatedDaysMax: nint(r.estimated_days_max, 'zone estimated_days_max'),
    }));
  const areaRates = db
    .all(
      `SELECT area, governorate, delivery_fee, free_shipping_threshold
         FROM shipping_area_rates WHERE store_id = ? AND is_active = 1 ORDER BY position ASC, id ASC`,
      [storeId]
    )
    .map(r => ({
      area: str(r.area, 'rate area'),
      governorate: str(r.governorate, 'rate governorate'),
      deliveryFee: nint(r.delivery_fee, 'rate delivery_fee') ?? 0,
      freeShippingThreshold: nint(r.free_shipping_threshold, 'rate free_shipping_threshold'),
      isActive: true,
    }));
  return { zones, areaRates };
}

/**
 * `ShippingService.calculateShipping`: area rate, else zone (whole folded names), else the FIRST zone when the
 * store has no area rates at all (legacy), else nothing matched. `orderTotal` is the goods total in piastres.
 */
export function calculateShipping(
  db: SyncSql,
  storeId: string,
  area: string,
  orderTotal: number,
  governorate?: string
): ShippingQuote {
  if (typeof storeId !== 'string' || !storeId) throw bad('storeId is required');
  if (typeof area !== 'string' || area.length > MAX_TEXT)
    throw bad('area must be text of at most 200 characters');
  if (
    governorate !== undefined &&
    (typeof governorate !== 'string' || governorate.length > MAX_TEXT)
  )
    throw bad('governorate must be text of at most 200 characters');
  if (!Number.isSafeInteger(orderTotal) || orderTotal < 0 || orderTotal > MAX_MONEY)
    throw bad('orderTotal must be a non-negative integer number of piastres');

  const { zones, areaRates } = loadShippingConfig(db, storeId);
  const storeHasAreaRates = areaRates.length > 0;
  const resolved = resolveShippingFee(areaRates, zones, {
    governorate: governorate ?? '',
    area,
    orderTotal,
  });
  const noMeta = { estimatedDays: null, estimatedDaysMin: null, estimatedDaysMax: null };
  const zoneMeta = (z: ZoneRow) => ({
    zone: { id: z.id, name: z.name, nameAr: z.nameAr },
    estimatedDays: z.estimatedDays,
    estimatedDaysMin: z.estimatedDaysMin,
    estimatedDaysMax: z.estimatedDaysMax,
  });

  if (resolved.matched) {
    if (resolved.source === 'area-rate') {
      return {
        matched: true,
        storeHasAreaRates,
        zone: null,
        shippingCost: resolved.shippingCost,
        freeShipping: resolved.freeShipping,
        ...noMeta,
      };
    }
    return {
      matched: true,
      storeHasAreaRates,
      shippingCost: resolved.shippingCost,
      freeShipping: resolved.freeShipping,
      ...zoneMeta(resolved.matchedZone as ZoneRow),
    };
  }

  if (areaRates.length === 0 && zones.length > 0) {
    const z = zones[0] as ZoneRow;
    const freeShipping = z.freeShippingThreshold != null && orderTotal >= z.freeShippingThreshold;
    return {
      matched: true,
      storeHasAreaRates: false,
      shippingCost: freeShipping ? 0 : z.deliveryFee,
      freeShipping,
      ...zoneMeta(z),
    };
  }

  return {
    matched: false,
    storeHasAreaRates,
    zone: null,
    shippingCost: 0,
    freeShipping: false,
    ...noMeta,
  };
}
