import { describe, it, expect } from 'vitest';
import { resolveShippingFee } from '../../apps/api/src/services/shipping.service';

const rate = (area: string, fee: number, governorate = 'Hawalli', freeOver?: number) => ({
  area,
  governorate,
  deliveryFee: fee,
  freeShippingThreshold: freeOver ?? null,
  isActive: true,
});

describe('resolveShippingFee priority', () => {
  it('prefers an exact per-area rate', () => {
    const r = resolveShippingFee([rate('Salmiya', 1500)], [], {
      governorate: 'Hawalli',
      area: 'Salmiya',
      orderTotal: 5000,
    });
    expect(r.shippingCost).toBe(1500);
    expect(r.matched).toBe(true);
    expect(r.source).toBe('area-rate');
  });
  it('applies free-shipping threshold on the area rate', () => {
    const r = resolveShippingFee([rate('Salmiya', 1500, 'Hawalli', 10000)], [], {
      governorate: 'Hawalli',
      area: 'Salmiya',
      orderTotal: 20000,
    });
    expect(r.shippingCost).toBe(0);
    expect(r.freeShipping).toBe(true);
  });
  it('falls back to legacy zone when no area rate', () => {
    const zones = [{ areas: ['Salmiya'], deliveryFee: 999, freeShippingThreshold: null }];
    const r = resolveShippingFee([], zones as any, {
      governorate: 'Hawalli',
      area: 'Salmiya',
      orderTotal: 5000,
    });
    expect(r.shippingCost).toBe(999);
  });
  it('returns 0 + matched:false when nothing matches', () => {
    const r = resolveShippingFee([], [], { governorate: 'Jahra', area: 'Kabd', orderTotal: 5000 });
    expect(r.shippingCost).toBe(0);
    expect(r.matched).toBe(false);
  });

  it('rates exist but none match the area AND no zone matches → matched:false, shippingCost:0 (no zone fallback)', () => {
    const zones = [{ areas: ['Jabriya'], deliveryFee: 777, freeShippingThreshold: null }];
    const r = resolveShippingFee([rate('Salmiya', 1500)], zones as any, {
      governorate: 'Hawalli',
      area: 'Bayan',
      orderTotal: 5000,
    });
    expect(r.shippingCost).toBe(0);
    expect(r.matched).toBe(false);
  });

  it('governorate disambiguation: same area name in two governorates resolves to the correct rate', () => {
    const rates = [rate('Rumaithiya', 800, 'Hawalli'), rate('Rumaithiya', 1200, 'Ahmadi')];
    const hawalli = resolveShippingFee(rates, [], {
      governorate: 'Hawalli',
      area: 'Rumaithiya',
      orderTotal: 5000,
    });
    expect(hawalli.shippingCost).toBe(800);
    expect(hawalli.matched).toBe(true);
    expect(hawalli.source).toBe('area-rate');

    const ahmadi = resolveShippingFee(rates, [], {
      governorate: 'Ahmadi',
      area: 'Rumaithiya',
      orderTotal: 5000,
    });
    expect(ahmadi.shippingCost).toBe(1200);
    expect(ahmadi.matched).toBe(true);
    expect(ahmadi.source).toBe('area-rate');
  });

  it('free-shipping threshold of 0 (always free) is honoured (not treated as falsy)', () => {
    const zones = [{ areas: ['Salmiya'], deliveryFee: 500, freeShippingThreshold: 0 }];
    const r = resolveShippingFee([], zones as any, {
      governorate: 'Hawalli',
      area: 'Salmiya',
      orderTotal: 0,
    });
    expect(r.freeShipping).toBe(true);
    expect(r.shippingCost).toBe(0);
  });
});
