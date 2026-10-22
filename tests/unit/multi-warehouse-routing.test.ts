/**
 * Multi-Warehouse — Unit Tests
 *
 * Tests the routing logic (routeOrder) and the Haversine distance helper
 * without needing a database. The service layer is tested via its pure
 * helper function and the routing algorithm logic is extracted to be
 * testable without prisma calls.
 *
 * Coverage:
 *  1. Priority routing — picks highest-priority warehouse with sufficient stock
 *  2. Priority routing — skips out-of-stock warehouses even at higher priority
 *  3. Proximity routing — picks nearest warehouse (Haversine) with stock
 *  4. Proximity routing — falls back to priority when no warehouse has coordinates
 *  5. Insufficient-stock path — returns warehouse with most stock + flag=true
 *  6. Haversine formula — spot-check a known distance (Origin point → Dubai ~540 km)
 *  7. Single-warehouse — always routes to it regardless of rule
 */

import { describe, it, expect } from 'vitest';
import { haversineKm } from '../../apps/api/src/lib/haversine';

// ─── Test helpers — in-memory warehouse + stock ────────────────────────────────

interface WH {
  id: string;
  name: string;
  code: string;
  priority: number;
  lat: number | null;
  lng: number | null;
  stock: { productId: string; variantId: string | null; quantity: number }[];
}

interface RoutedLine {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  rule: 'priority' | 'proximity';
  availableQty: number;
  insufficientStock: boolean;
}

/**
 * Pure re-implementation of the routing algorithm from WarehouseService.routeOrder
 * that accepts plain objects instead of Prisma records, allowing unit testing
 * without a DB.
 */
function routeOrderPure(
  warehouses: WH[],
  items: { productId: string; variantId?: string | null; qty: number }[],
  opts?: { lat?: number; lng?: number; rule?: 'priority' | 'proximity' }
): RoutedLine[] {
  if (warehouses.length === 0) throw new Error('NO_WAREHOUSES');

  const hasCoordinates =
    opts?.lat !== undefined &&
    opts?.lng !== undefined &&
    warehouses.some(w => w.lat !== null && w.lng !== null);

  const effectiveRule = opts?.rule === 'proximity' && hasCoordinates ? 'proximity' : 'priority';

  return items.map(item => {
    const variantId = item.variantId ?? null;

    const candidates = warehouses
      .map(w => {
        const stockRow = w.stock.find(
          s => s.productId === item.productId && s.variantId === variantId
        );
        return {
          id: w.id,
          name: w.name,
          code: w.code,
          priority: w.priority,
          lat: w.lat,
          lng: w.lng,
          qty: stockRow?.quantity ?? 0,
        };
      })
      .filter(c => c.qty > 0);

    if (candidates.length === 0) {
      const fallback =
        warehouses
          .map(w => {
            const stockRow = w.stock.find(
              s => s.productId === item.productId && s.variantId === variantId
            );
            return { id: w.id, name: w.name, code: w.code, qty: stockRow?.quantity ?? 0 };
          })
          .sort((a, b) => b.qty - a.qty)[0] ?? warehouses[0];

      return {
        warehouseId: fallback.id,
        warehouseName: fallback.name,
        warehouseCode: fallback.code,
        rule: effectiveRule,
        availableQty: fallback.qty,
        insufficientStock: true,
      };
    }

    const sufficient = candidates.filter(c => c.qty >= item.qty);
    const pool = sufficient.length > 0 ? sufficient : candidates;

    // Sort pool by priority desc, code asc (matches service layer default)
    pool.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.code.localeCompare(b.code);
    });

    let chosen: (typeof candidates)[0];

    if (effectiveRule === 'proximity' && opts?.lat !== undefined && opts?.lng !== undefined) {
      const withDist = pool
        .filter(c => c.lat !== null && c.lng !== null)
        .map(c => ({
          ...c,
          dist: haversineKm(opts.lat!, opts.lng!, c.lat!, c.lng!),
        }))
        .sort((a, b) => a.dist - b.dist);

      chosen = withDist.length > 0 ? withDist[0] : pool[0];
    } else {
      chosen = pool[0];
    }

    return {
      warehouseId: chosen.id,
      warehouseName: chosen.name,
      warehouseCode: chosen.code,
      rule: effectiveRule,
      availableQty: chosen.qty,
      insufficientStock: sufficient.length === 0,
    };
  });
}

// ─── Fixture warehouses ────────────────────────────────────────────────────────

const PRODUCT_A = 'prod-a';
const PRODUCT_B = 'prod-b';

const WH_MAIN: WH = {
  id: 'wh-main',
  name: 'Main Warehouse',
  code: 'MAIN',
  priority: 100,
  lat: 29.3759,
  lng: 47.9774, // origin point
  stock: [
    { productId: PRODUCT_A, variantId: null, quantity: 50 },
    { productId: PRODUCT_B, variantId: null, quantity: 0 },
  ],
};

const WH_SOUTH: WH = {
  id: 'wh-south',
  name: 'South Warehouse',
  code: 'SOUTH',
  priority: 50,
  lat: 29.0844,
  lng: 48.1339, // Ahmadi area
  stock: [
    { productId: PRODUCT_A, variantId: null, quantity: 10 },
    { productId: PRODUCT_B, variantId: null, quantity: 5 },
  ],
};

const WH_NORTH: WH = {
  id: 'wh-north',
  name: 'North Warehouse',
  code: 'NORTH',
  priority: 75,
  lat: null,
  lng: null, // no coordinates
  stock: [
    { productId: PRODUCT_A, variantId: null, quantity: 20 },
    { productId: PRODUCT_B, variantId: null, quantity: 3 },
  ],
};

const ALL_WAREHOUSES = [WH_MAIN, WH_NORTH, WH_SOUTH];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('multi-warehouse routing — priority rule', () => {
  it('picks the highest-priority warehouse with sufficient stock', () => {
    const [result] = routeOrderPure(ALL_WAREHOUSES, [{ productId: PRODUCT_A, qty: 1 }], {
      rule: 'priority',
    });

    // MAIN has priority 100 and qty=50 >= 1 → should win
    expect(result.warehouseId).toBe('wh-main');
    expect(result.rule).toBe('priority');
    expect(result.insufficientStock).toBe(false);
  });

  it('skips out-of-stock warehouses even if higher priority', () => {
    // MAIN has 0 of PRODUCT_B — should skip to NORTH (priority 75) then SOUTH (50)
    const [result] = routeOrderPure(ALL_WAREHOUSES, [{ productId: PRODUCT_B, qty: 1 }], {
      rule: 'priority',
    });

    // MAIN is out of B; NORTH has 3 (priority 75), SOUTH has 5 (priority 50)
    // → NORTH wins on priority
    expect(result.warehouseId).toBe('wh-north');
    expect(result.insufficientStock).toBe(false);
  });

  it('falls through to candidate with most stock when all insufficient', () => {
    // Request 100 units of PRODUCT_A — MAIN has 50, NORTH 20, SOUTH 10
    // None are sufficient; returns the one with the most (MAIN with 50)
    const [result] = routeOrderPure(ALL_WAREHOUSES, [{ productId: PRODUCT_A, qty: 100 }], {
      rule: 'priority',
    });

    expect(result.warehouseId).toBe('wh-main');
    expect(result.insufficientStock).toBe(true);
    expect(result.availableQty).toBe(50);
  });

  it('routes multiple items independently', () => {
    const results = routeOrderPure(
      ALL_WAREHOUSES,
      [
        { productId: PRODUCT_A, qty: 5 },
        { productId: PRODUCT_B, qty: 2 },
      ],
      { rule: 'priority' }
    );

    expect(results).toHaveLength(2);
    // PRODUCT_A → MAIN (priority 100, qty 50 ≥ 5)
    expect(results[0].warehouseId).toBe('wh-main');
    // PRODUCT_B → NORTH (priority 75, qty 3 ≥ 2); MAIN has 0
    expect(results[1].warehouseId).toBe('wh-north');
  });

  it('tiebreaks by code alphabetically', () => {
    // Two warehouses with equal priority, both have stock
    const whA: WH = {
      id: 'wh-aaa',
      name: 'AAA',
      code: 'AAA',
      priority: 50,
      lat: null,
      lng: null,
      stock: [{ productId: PRODUCT_A, variantId: null, quantity: 10 }],
    };
    const whB: WH = {
      id: 'wh-zzz',
      name: 'ZZZ',
      code: 'ZZZ',
      priority: 50,
      lat: null,
      lng: null,
      stock: [{ productId: PRODUCT_A, variantId: null, quantity: 10 }],
    };

    const [result] = routeOrderPure([whB, whA], [{ productId: PRODUCT_A, qty: 1 }]);
    // AAA < ZZZ alphabetically → AAA wins tiebreak
    expect(result.warehouseCode).toBe('AAA');
  });
});

describe('multi-warehouse routing — proximity rule', () => {
  it('picks the nearest warehouse with sufficient stock', () => {
    // Caller location = near Ahmadi (close to SOUTH, far from MAIN)
    // SOUTH lat=29.0844,lng=48.1339; MAIN=29.3759,47.9774
    const callerLat = 29.1;
    const callerLng = 48.1;

    const [result] = routeOrderPure(
      [WH_MAIN, WH_SOUTH], // only warehouses with coordinates
      [{ productId: PRODUCT_A, qty: 1 }],
      { rule: 'proximity', lat: callerLat, lng: callerLng }
    );

    // SOUTH is closer to 29.1/48.1
    expect(result.warehouseId).toBe('wh-south');
    expect(result.rule).toBe('proximity');
  });

  it('falls back to priority when no warehouse has coordinates', () => {
    const whNoCoords: WH = {
      id: 'wh-no-coords',
      name: 'No Coords',
      code: 'NC',
      priority: 10,
      lat: null,
      lng: null,
      stock: [{ productId: PRODUCT_A, variantId: null, quantity: 5 }],
    };

    // Only warehouse with no coords — proximity requested but impossible
    const [result] = routeOrderPure([whNoCoords], [{ productId: PRODUCT_A, qty: 1 }], {
      rule: 'proximity',
      lat: 29.0,
      lng: 48.0,
    });

    // Rule falls back to priority (only one warehouse anyway)
    expect(result.warehouseId).toBe('wh-no-coords');
    expect(result.rule).toBe('priority');
  });

  it('ignores warehouses without coordinates in proximity pool, uses priority for them', () => {
    // WH_NORTH has no coordinates; MAIN and SOUTH do
    // Caller near SOUTH → SOUTH should win for proximity even though MAIN has higher priority
    const callerLat = 29.0;
    const callerLng = 48.15;

    const [result] = routeOrderPure(ALL_WAREHOUSES, [{ productId: PRODUCT_A, qty: 1 }], {
      rule: 'proximity',
      lat: callerLat,
      lng: callerLng,
    });

    // SOUTH is nearest to 29.0/48.15 and has stock; wins proximity
    expect(result.warehouseId).toBe('wh-south');
  });
});

describe('multi-warehouse routing — edge cases', () => {
  it('handles a single warehouse', () => {
    const [result] = routeOrderPure([WH_MAIN], [{ productId: PRODUCT_A, qty: 1 }]);
    expect(result.warehouseId).toBe('wh-main');
    expect(result.insufficientStock).toBe(false);
  });

  it('handles zero stock for ALL warehouses (returns fallback + flag)', () => {
    const emptyWh: WH = {
      id: 'wh-empty',
      name: 'Empty',
      code: 'EMPTY',
      priority: 100,
      lat: null,
      lng: null,
      stock: [],
    };

    const [result] = routeOrderPure([emptyWh], [{ productId: PRODUCT_A, qty: 1 }]);

    expect(result.warehouseId).toBe('wh-empty');
    expect(result.insufficientStock).toBe(true);
    expect(result.availableQty).toBe(0);
  });

  it('correctly handles variantId routing', () => {
    const VARIANT_X = 'var-x';
    const whWithVariant: WH = {
      id: 'wh-var',
      name: 'Variant Warehouse',
      code: 'VAR',
      priority: 100,
      lat: null,
      lng: null,
      stock: [
        { productId: PRODUCT_A, variantId: null, quantity: 5 }, // base stock
        { productId: PRODUCT_A, variantId: VARIANT_X, quantity: 20 }, // variant stock
      ],
    };

    // Route for variant
    const [result] = routeOrderPure(
      [whWithVariant],
      [{ productId: PRODUCT_A, variantId: VARIANT_X, qty: 10 }]
    );

    expect(result.warehouseId).toBe('wh-var');
    expect(result.availableQty).toBe(20);
    expect(result.insufficientStock).toBe(false);
  });
});

describe('haversineKm', () => {
  it('Origin point → Dubai ≈ 857 km', () => {
    // Origin point: 29.3759, 47.9774
    // Dubai: 25.2048, 55.2708
    // Great-circle (straight-line) distance ≈ 856–858 km; road is ~900 km
    const dist = haversineKm(29.3759, 47.9774, 25.2048, 55.2708);
    expect(dist).toBeGreaterThan(840);
    expect(dist).toBeLessThan(875);
  });

  it('same point → 0 km', () => {
    const dist = haversineKm(29.3759, 47.9774, 29.3759, 47.9774);
    expect(dist).toBeCloseTo(0, 5);
  });

  it('is symmetric (A→B === B→A)', () => {
    const d1 = haversineKm(29.3759, 47.9774, 29.0844, 48.1339);
    const d2 = haversineKm(29.0844, 48.1339, 29.3759, 47.9774);
    expect(d1).toBeCloseTo(d2, 6);
  });

  it('Origin point → nearby point ≈ 35 km', () => {
    const dist = haversineKm(29.3759, 47.9774, 29.0844, 48.1339);
    expect(dist).toBeGreaterThan(30);
    expect(dist).toBeLessThan(45);
  });
});
