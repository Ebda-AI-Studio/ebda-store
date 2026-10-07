import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPublicShippingZones } from '../shipping-public';

/**
 * These tests exist because the first version of this helper passed its unit
 * tests and did nothing in production. Two independent silent failures:
 *
 *   1. Wrong path — shipping routes mount under `/stores`, so the endpoint is
 *      `/stores/public/:id/shipping`, not `/public/:id/shipping`. The helper
 *      swallows failures by design, so a 404 degraded to an empty list.
 *   2. Wrong source — it read `ShippingZone` only, but real merchants use
 *      `ShippingAreaRate` (Demo Store: full Egypt list, zero zones).
 *
 * Both are only observable by asserting on the URLs called and on area-rate
 * data flowing through, which is what these tests do.
 */
describe('fetchPublicShippingZones', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it('calls the /stores-mounted paths, not the bare /public paths', async () => {
    fetchMock.mockResolvedValue(ok({ data: {} }));
    await fetchPublicShippingZones('store-1');

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('/stores/public/store-1/shipping'))).toBe(true);
    expect(urls.some(u => u.includes('/stores/public/store-1/shipping/area-rates'))).toBe(true);
    // The exact path that 404'd in production must never come back.
    expect(urls.some(u => u.includes('/api/v1/public/store-1/shipping'))).toBe(false);
  });

  it('includes AREA RATES, which is what real merchants actually configure', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/area-rates')
          ? ok({
              data: {
                rates: [
                  {
                    area: 'Cairo',
                    governorate: 'Capital',
                    deliveryFee: 3000,
                    freeShippingThreshold: null,
                  },
                  {
                    area: 'Sharq',
                    governorate: 'Capital',
                    deliveryFee: 2500,
                    freeShippingThreshold: null,
                  },
                ],
              },
            })
          : ok({ data: { zones: [] } })
      )
    );

    const out = await fetchPublicShippingZones('store-1');
    expect(out).toHaveLength(2);
    expect(out.map(z => z.deliveryFee).sort()).toEqual([2500, 3000]);
    // No day estimate on area rates -> deliveryTime must be omitted downstream.
    expect(out.every(z => z.estimatedDaysMin === null && z.estimatedDays === null)).toBe(true);
  });

  it('merges zones and area rates so the cheapest across BOTH can win', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/area-rates')
          ? ok({
              data: { rates: [{ area: 'Sharq', deliveryFee: 3000, freeShippingThreshold: null }] },
            })
          : ok({
              data: {
                zones: [
                  {
                    name: 'Metro',
                    deliveryFee: 1000,
                    freeShippingThreshold: null,
                    estimatedDaysMin: 1,
                    estimatedDaysMax: 2,
                    estimatedDays: null,
                  },
                ],
              },
            })
      )
    );

    const out = await fetchPublicShippingZones('store-1');
    expect(out).toHaveLength(2);
    expect(Math.min(...out.map(z => z.deliveryFee))).toBe(1000);
  });

  it('degrades to [] when both sources fail, never throwing', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchPublicShippingZones('store-1')).resolves.toEqual([]);
  });

  it('skips the demo store without any network call', async () => {
    await expect(fetchPublicShippingZones('demo')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
