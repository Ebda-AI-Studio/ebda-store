import { describe, it, expect } from 'vitest';
import { checkoutDeliveryEta } from './delivery-estimate';

/** CK2: the checkout delivery option showed "توصيل عادي 60 ج.م" with no ETA though the store set delivery times. */
const cairo = { areas: ['Cairo'], areasAr: ['القاهرة'], estimatedDaysMin: 2, estimatedDaysMax: 4 };
const giza = { areas: ['Giza'], areasAr: ['الجيزة'], estimatedDaysMin: 3, estimatedDaysMax: 3 };
const addr = { governorate: 'Cairo', governorateAr: 'القاهرة', area: 'Maadi' };

describe('checkoutDeliveryEta', () => {
  it("uses the address's own zone, in Arabic and English", () => {
    const o = { zones: [giza, cairo], address: addr, storeDeliveryDays: null };
    expect(checkoutDeliveryEta(o, 'ar')).toBe('بيوصل خلال 2–4 أيام عمل');
    expect(checkoutDeliveryEta(o, 'en')).toBe('Arrives in 2–4 business days');
  });
  it('a single-number zone reads as one figure', () => {
    const o = { zones: [giza], address: { governorate: 'Giza' }, storeDeliveryDays: null };
    expect(checkoutDeliveryEta(o, 'ar')).toBe('بيوصل خلال 3 أيام عمل');
  });
  it('zones without day numbers fall back to the store-wide delivery times', () => {
    const zones = [{ areas: ['Cairo'], estimatedDaysMin: null, estimatedDaysMax: null }];
    expect(
      checkoutDeliveryEta({ zones, address: addr, storeDeliveryDays: { min: 1, max: 3 } }, 'en')
    ).toBe('Arrives in 1–3 business days');
  });
  it('no line when nothing is configured, or when numbered zones do not name this address', () => {
    expect(
      checkoutDeliveryEta({ zones: [], address: addr, storeDeliveryDays: null }, 'ar')
    ).toBeNull();
    expect(
      checkoutDeliveryEta({ zones: [], address: addr, storeDeliveryDays: { min: 0, max: 0 } }, 'ar')
    ).toBeNull();
    expect(
      checkoutDeliveryEta(
        { zones: [giza], address: addr, storeDeliveryDays: { min: 1, max: 2 } },
        'ar'
      )
    ).toBeNull();
  });
});
