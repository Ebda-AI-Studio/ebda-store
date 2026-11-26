/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';

// Ported from tests/integration/shipping-area-rate.test.ts (Postgres, RLS) to the built Worker + StoreDO: PUT area-rates/bulk then GET,
// the public calculate route (known area, unknown area, free-shipping threshold), and cross-store isolation (store B's owner gets 403
// on store A's area-rates, A's rates never appear for B). The calculation itself is also pinned in packages/repo/test/do-shipping-tax.test.ts.
let A: Merchant;
let B: Merchant;
const rate = (area: string, areaAr: string, fee: number, extra: object = {}) => ({
  country: 'EG',
  countryAr: 'مصر',
  governorate: 'Cairo',
  governorateAr: 'القاهرة',
  area,
  areaAr,
  deliveryFee: fee,
  ...extra,
});

describe('shipping area rates on the Worker', () => {
  beforeAll(async () => {
    A = await bootstrapMerchant('sar-a');
    B = await bootstrapMerchant('sar-b');
  }, 120_000);

  it('bulk-upserts two area rates and GET returns both', async () => {
    const put = await call(`/stores/${A.storeId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      token: A.token,
      body: {
        rates: [
          rate('Maadi', 'المعادي', 1500, { freeShippingThreshold: 100000 }),
          rate('Nasr City', 'مدينة نصر', 2000),
        ],
      },
    });
    expect(put.status, put.text).toBe(200);
    const got = await call(`/stores/${A.storeId}/shipping/area-rates`, { token: A.token });
    expect(got.status, got.text).toBe(200);
    const areas = (got.json.data.rates ?? got.json.data)
      .map((r: { area: string }) => r.area)
      .sort();
    expect(areas).toEqual(['Maadi', 'Nasr City']);
    // a second save of the same key updates, never duplicates
    await call(`/stores/${A.storeId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      token: A.token,
      body: { rates: [rate('Maadi', 'المعادي', 1700, { freeShippingThreshold: 100000 })] },
    });
    const again = await call(`/stores/${A.storeId}/shipping/area-rates`, { token: A.token });
    const rows = again.json.data.rates ?? again.json.data;
    expect(rows.filter((r: { area: string }) => r.area === 'Maadi')).toHaveLength(1);
    expect(rows.find((r: { area: string }) => r.area === 'Maadi').deliveryFee).toBe(1700);
  });

  it('public calculate: known area matches, unknown area is free + unmatched, threshold makes it free', async () => {
    const calc = (area: string, orderTotal: number) =>
      call(`/stores/public/${A.storeId}/shipping/calculate`, {
        method: 'POST',
        body: { governorate: 'Cairo', area, orderTotal },
      });
    const known = await calc('Maadi', 5000);
    expect(known.status, known.text).toBe(200);
    expect(known.json.data).toMatchObject({ shippingCost: 1700, matched: true });
    const unknown = await calc('Nowhere', 5000);
    expect(unknown.json.data).toMatchObject({ shippingCost: 0, matched: false });
    const free = await calc('Maadi', 100000);
    expect(free.json.data).toMatchObject({ shippingCost: 0, freeShipping: true });
  });

  it('store B owner is refused on store A, A rates never reach B, and B manages its own', async () => {
    const getA = await call(`/stores/${A.storeId}/shipping/area-rates`, { token: B.token });
    expect(getA.status).toBe(403);
    const putA = await call(`/stores/${A.storeId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      token: B.token,
      body: { rates: [rate('Zamalek', 'الزمالك', 1)] },
    });
    expect(putA.status).toBe(403);
    const getB = await call(`/stores/${B.storeId}/shipping/area-rates`, { token: B.token });
    expect(getB.status).toBe(200);
    expect(JSON.stringify(getB.json)).not.toContain('Maadi');
    const putB = await call(`/stores/${B.storeId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      token: B.token,
      body: { rates: [rate('Heliopolis', 'مصر الجديدة', 900)] },
    });
    expect(putB.status, putB.text).toBe(200);
    const afterA = await call(`/stores/${A.storeId}/shipping/area-rates`, { token: A.token });
    expect(JSON.stringify(afterA.json)).not.toContain('Heliopolis');
  });
});
