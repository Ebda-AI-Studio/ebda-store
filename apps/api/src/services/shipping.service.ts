import { Prisma } from '@ebda/database';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { zoneForAddress } from '@ebda/shared';

// ─── Pure fee resolver (no DB) ────────────────────────────────────────────────

interface AreaRate {
  area: string;
  governorate: string;
  deliveryFee: number;
  freeShippingThreshold: number | null;
  isActive: boolean;
}

interface ZoneLike {
  areas: string[] | unknown;
  deliveryFee: number;
  freeShippingThreshold: number | null;
}

interface ResolveInput {
  governorate: string;
  area: string;
  orderTotal: number;
}

export interface ResolvedShippingFee {
  shippingCost: number;
  freeShipping: boolean;
  matched: boolean;
  source: 'area-rate' | 'zone' | 'none';
  /** The matched ZoneLike object when source==='zone'; null otherwise. */
  matchedZone: ZoneLike | null;
}

/**
 * Pure function — no DB calls.
 *
 * Priority:
 *  1. Exact per-area rate (case-insensitive EN match on area name).
 *     When governorate is provided/non-empty, also matches rate.governorate
 *     case-insensitively to disambiguate same-named areas across governorates.
 *  2. Legacy ShippingZone match (`zoneForAddress`: whole folded names, area then governorate)
 *  3. Nothing matched → { shippingCost:0, freeShipping:false, matched:false, source:'none' }
 */
export function resolveShippingFee(
  rates: AreaRate[],
  zones: ZoneLike[],
  { governorate, area, orderTotal }: ResolveInput
): ResolvedShippingFee {
  // Priority 1 — per-area rate
  const activeRates = rates.filter(r => r.isActive);
  const matchedRate = activeRates.find(r => {
    const areaMatch = r.area.toLowerCase() === area.toLowerCase();
    if (!areaMatch) return false;
    // Governorate disambiguation: when caller supplies a non-empty governorate,
    // require it to match so same-named areas in different governorates resolve
    // to the correct rate (the same area name can exist in two governorates).
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

  // Priority 2 — legacy zone matching: the receipt's rule (`zoneForAddress`), so the
  // zone the shopper is charged for is the zone whose window the receipt promises.
  // Whole names after folding, area first, then governorate; never a substring
  // ("Victoria" is not "Tor"; B0-46 T15 carry 5).
  const matchedZone = zoneForAddress(
    { area, governorate },
    zones as Array<ZoneLike & { areas?: string[] | null; areasAr?: string[] | null }>
  );
  if (matchedZone) {
    const freeShipping =
      matchedZone.freeShippingThreshold != null && orderTotal >= matchedZone.freeShippingThreshold;
    return {
      shippingCost: freeShipping ? 0 : matchedZone.deliveryFee,
      freeShipping,
      matched: true,
      source: 'zone',
      matchedZone,
    };
  }

  // Priority 3 — nothing matched
  return {
    shippingCost: 0,
    freeShipping: false,
    matched: false,
    source: 'none',
    matchedZone: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

interface CreateShippingZoneData {
  name: string;
  nameAr?: string;
  areas: string[];
  areasAr?: string[];
  deliveryFee: number;
  freeShippingThreshold?: number;
  estimatedDays?: number;
  estimatedDaysMin?: number;
  estimatedDaysMax?: number;
  position?: number;
  isActive?: boolean;
}

type UpdateShippingZoneData = Partial<CreateShippingZoneData>;

interface ListShippingZonesOptions {
  page?: number;
  limit?: number;
  isActive?: boolean;
}

export class ShippingService {
  static async list(storeId: string, options: ListShippingZonesOptions = {}) {
    const db = await storeDb(storeId);
    const { page = 1, limit = 50, isActive } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ShippingZoneWhereInput = { storeId };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [zones, total] = await Promise.all([
      db.shippingZone.findMany({
        where,
        skip,
        take: limit,
        orderBy: { position: 'asc' },
      }),
      db.shippingZone.count({ where }),
    ]);

    return {
      zones,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string, zoneId: string) {
    const db = await storeDb(storeId);
    const zone = await db.shippingZone.findFirst({
      where: { id: zoneId, storeId },
    });

    if (!zone) {
      throw new AppError(404, 'NOT_FOUND', 'Shipping zone not found');
    }

    return zone;
  }

  static async create(storeId: string, data: CreateShippingZoneData) {
    const db = await storeDb(storeId);
    const w = await storeWriter(storeId);
    // Get the highest position for this store
    const maxPosition = await db.shippingZone.aggregate({
      where: { storeId },
      _max: { position: true },
    });

    const zone = await w.shippingZone.create({
      data: {
        storeId,
        name: data.name,
        nameAr: data.nameAr,
        areas: data.areas,
        areasAr: data.areasAr || [],
        deliveryFee: data.deliveryFee,
        freeShippingThreshold: data.freeShippingThreshold,
        estimatedDays: data.estimatedDays,
        estimatedDaysMin: data.estimatedDaysMin,
        estimatedDaysMax: data.estimatedDaysMax,
        position: data.position ?? (maxPosition._max.position || 0) + 1,
        isActive: data.isActive ?? true,
      },
    });

    return zone;
  }

  static async update(storeId: string, zoneId: string, data: UpdateShippingZoneData) {
    const w = await storeWriter(storeId);
    await this.getById(storeId, zoneId);

    const zone = await w.shippingZone.update({
      where: { id: zoneId, storeId },
      data: {
        name: data.name,
        nameAr: data.nameAr,
        areas: data.areas,
        areasAr: data.areasAr,
        deliveryFee: data.deliveryFee,
        freeShippingThreshold: data.freeShippingThreshold,
        estimatedDays: data.estimatedDays,
        estimatedDaysMin: data.estimatedDaysMin,
        estimatedDaysMax: data.estimatedDaysMax,
        position: data.position,
        isActive: data.isActive,
      },
    });

    return zone;
  }

  static async delete(storeId: string, zoneId: string) {
    const w = await storeWriter(storeId);
    await this.getById(storeId, zoneId);

    await w.shippingZone.delete({
      where: { id: zoneId, storeId },
    });
  }

  static async toggleActive(storeId: string, zoneId: string) {
    const w = await storeWriter(storeId);
    const zone = await this.getById(storeId, zoneId);

    const updatedZone = await w.shippingZone.update({
      where: { id: zoneId, storeId },
      data: { isActive: !zone.isActive },
    });

    return updatedZone;
  }

  static async reorder(storeId: string, zoneIds: string[]) {
    const db = await storeDb(storeId);
    const w = await storeWriter(storeId);
    // Verify all zones belong to this store
    const zones = await db.shippingZone.findMany({
      where: { storeId, id: { in: zoneIds } },
    });

    if (zones.length !== zoneIds.length) {
      throw new AppError(400, 'INVALID_ZONES', 'Some shipping zones not found');
    }

    // Update positions
    await w.$transaction(
      zoneIds.map((id, index) =>
        w.shippingZone.update({
          where: { id, storeId },
          data: { position: index },
        })
      )
    );

    return this.list(storeId);
  }

  /**
   * Calculate shipping cost for an order based on delivery area.
   *
   * Fee resolution priority:
   *  1. Exact per-area ShippingAreaRate (case-insensitive EN match)
   *  2. Legacy ShippingZone, matched by WHOLE place name after folding, area first then
   *     governorate (`zoneForAddress`, Ruling FU46-13)
   *  3. Fallback to first zone when no area rates exist (legacy behaviour, unchanged)
   *  4. Nothing matched → shippingCost:0, no zone
   *
   * The `governorate` parameter is optional for backward compatibility.
   * Existing callers that only pass (storeId, area, orderTotal) continue to work.
   */
  static async calculateShipping(
    storeId: string,
    area: string,
    orderTotal: number,
    governorate?: string
  ) {
    const db = await storeDb(storeId);
    // Fetch active zones and per-area rates in parallel
    const [zones, areaRates] = await Promise.all([
      db.shippingZone.findMany({
        where: { storeId, isActive: true },
        orderBy: { position: 'asc' },
      }),
      db.shippingAreaRate.findMany({
        where: { storeId, isActive: true },
      }),
    ]);

    // Try the priority resolver (area-rate → zone match)
    const resolved = resolveShippingFee(areaRates, zones, {
      governorate: governorate ?? '',
      area,
      orderTotal,
    });

    if (resolved.matched) {
      if (resolved.source === 'area-rate') {
        // No zone metadata for area-rate resolution
        return {
          matched: true,
          storeHasAreaRates: areaRates.length > 0,
          zone: null,
          shippingCost: resolved.shippingCost,
          freeShipping: resolved.freeShipping,
          estimatedDays: null,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        };
      }

      // source === 'zone' — resolver already captured the matched zone object
      const matchedZone = resolved.matchedZone as (typeof zones)[0];
      return {
        matched: true,
        storeHasAreaRates: areaRates.length > 0,
        zone: {
          id: matchedZone.id,
          name: matchedZone.name,
          nameAr: matchedZone.nameAr,
        },
        shippingCost: resolved.shippingCost,
        freeShipping: resolved.freeShipping,
        estimatedDays: matchedZone.estimatedDays,
        estimatedDaysMin: matchedZone.estimatedDaysMin,
        estimatedDaysMax: matchedZone.estimatedDaysMax,
      };
    }

    // No area rates exist and no zone matched the area — apply the legacy
    // fallback-to-first-zone behaviour ONLY when no area rates are configured
    // (preserves existing behaviour for stores with zones only).
    if (areaRates.length === 0 && zones.length > 0) {
      const fallbackZone = zones[0];
      const freeShipping =
        fallbackZone.freeShippingThreshold != null &&
        orderTotal >= fallbackZone.freeShippingThreshold;
      return {
        matched: true,
        storeHasAreaRates: false,
        zone: {
          id: fallbackZone.id,
          name: fallbackZone.name,
          nameAr: fallbackZone.nameAr,
        },
        shippingCost: freeShipping ? 0 : fallbackZone.deliveryFee,
        freeShipping,
        estimatedDays: fallbackZone.estimatedDays,
        estimatedDaysMin: fallbackZone.estimatedDaysMin,
        estimatedDaysMax: fallbackZone.estimatedDaysMax,
      };
    }

    // Nothing matched
    return {
      matched: false,
      storeHasAreaRates: areaRates.length > 0,
      zone: null,
      shippingCost: 0,
      freeShipping: false,
      estimatedDays: null,
      estimatedDaysMin: null,
      estimatedDaysMax: null,
    };
  }

  /**
   * Get public shipping zones for storefront
   */
  static async getPublicZones(storeId: string) {
    const db = await storeDb(storeId);
    const zones = await db.shippingZone.findMany({
      where: { storeId, isActive: true },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        nameAr: true,
        areas: true,
        areasAr: true,
        deliveryFee: true,
        freeShippingThreshold: true,
        estimatedDays: true,
        estimatedDaysMin: true,
        estimatedDaysMax: true,
      },
    });

    return zones;
  }
}
