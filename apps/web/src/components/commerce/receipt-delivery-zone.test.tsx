// @vitest-environment jsdom
/**
 * S-02 follow-up (W1c review I4): the receipt's delivery window is the ORDER's
 * shipping zone, never the store's fastest zone. A store with Cairo at 1–2 days
 * and Aswan at 5–7 used to print the Cairo dates on an Aswan order's receipt.
 * An address that matches no zone gets no window at all.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { zoneForAddress } from '@ebda/shared';

const ZONES = vi.hoisted(() => [
  {
    name: 'Greater Cairo',
    deliveryFee: 5000,
    freeShippingThreshold: null,
    estimatedDaysMin: 1,
    estimatedDaysMax: 2,
    estimatedDays: null,
    areas: ['Cairo', 'Nasr City', 'Giza'],
    areasAr: ['القاهرة', 'مدينة نصر', 'الجيزة'],
  },
  {
    name: 'Upper Egypt',
    deliveryFee: 9000,
    freeShippingThreshold: null,
    estimatedDaysMin: 5,
    estimatedDaysMax: 7,
    estimatedDays: null,
    areas: ['Aswan', 'Luxor City'],
    areasAr: ['أسوان', 'الأقصر'],
  },
]);
let storeId = 's-a';
vi.mock('@/lib/shipping-public', () => ({ fetchPublicShippingZones: async () => ZONES }));
vi.mock('@/contexts/StoreContext', () => ({
  useStore: () => ({
    store: {
      id: storeId,
      timezone: 'Africa/Cairo',
      settings: { deliveryDays: { min: 2, max: 3 } },
    },
  }),
}));
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', isRtl: false, t: (en: string) => en }),
}));
vi.mock('@/hooks/useNumerals', () => ({
  useStoreNumerals: () => 'latn',
  useNumerals: () => ({ localize: (v: string | number) => String(v), numerals: 'latn' }),
}));

import { useDeliveryWindow } from './DeliveryChip';

afterEach(cleanup);

// Wednesday 14 Oct 2026, 13:00 Cairo. Business days skip Friday.
const ORDER_DATE = new Date('2026-10-14T10:00:00Z');

function Probe({ address }: { address: Record<string, string> | null }) {
  const w = useDeliveryWindow({ from: ORDER_DATE, address });
  return <p data-testid="w">{w ? `${w.from} | ${w.to}` : 'none'}</p>;
}

describe('zoneForAddress', () => {
  it('matches the area, then the city, then the governorate, in en or ar', () => {
    expect(zoneForAddress({ area: 'Nasr City', governorate: 'Cairo' }, ZONES)?.name).toBe(
      'Greater Cairo'
    );
    expect(zoneForAddress({ area: 'Edfu', governorate: 'Aswan' }, ZONES)?.name).toBe('Upper Egypt');
    expect(zoneForAddress({ areaAr: 'إدفو', governorateAr: 'أسوان' }, ZONES)?.name).toBe(
      'Upper Egypt'
    );
    expect(zoneForAddress({ area: 'Luxor City' }, ZONES)?.name).toBe('Upper Egypt');
  });
  it('an address no zone names → null (never the fastest zone)', () => {
    expect(zoneForAddress({ area: 'Marsa Alam', governorate: 'Red Sea' }, ZONES)).toBeNull();
    expect(zoneForAddress({}, ZONES)).toBeNull();
    expect(zoneForAddress(null, ZONES)).toBeNull();
  });
});

describe("the receipt's window is the order's zone", () => {
  it('an Aswan order gets the Aswan window (5–7 business days: Tue 20 – Thu 22 Oct)', async () => {
    storeId = 's-aswan';
    render(<Probe address={{ governorate: 'Aswan', area: 'Edfu' }} />);
    await waitFor(() => expect(screen.getByTestId('w').textContent).not.toBe('none'));
    const t = screen.getByTestId('w').textContent!;
    expect(t).toMatch(/20 Oct/);
    expect(t).toMatch(/22 Oct/);
    expect(t).not.toMatch(/15 Oct/);
  });

  it('a Cairo order gets the Cairo window (1–2 business days: Thu 15 – Sat 17 Oct)', async () => {
    storeId = 's-cairo';
    render(<Probe address={{ governorate: 'Cairo', area: 'Nasr City' }} />);
    await waitFor(() => expect(screen.getByTestId('w').textContent).not.toBe('none'));
    const t = screen.getByTestId('w').textContent!;
    expect(t).toMatch(/15 Oct/);
    expect(t).toMatch(/17 Oct/);
  });

  it('an address no zone names gets no window (not the fastest zone, not the store fallback)', async () => {
    storeId = 's-none';
    render(<Probe address={{ governorate: 'Red Sea', area: 'Marsa Alam' }} />);
    // give the zones fetch time to resolve, then it must still be "none"
    await new Promise(r => setTimeout(r, 50));
    expect(screen.getByTestId('w').textContent).toBe('none');
  });

  it('the order not loaded yet → no window', async () => {
    storeId = 's-null';
    render(<Probe address={null} />);
    await new Promise(r => setTimeout(r, 50));
    expect(screen.getByTestId('w').textContent).toBe('none');
  });
});
