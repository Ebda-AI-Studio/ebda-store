// @vitest-environment jsdom
/**
 * GoldPricingCard (B5 Task 13): the live preview is the server's own formula on the same integers, the
 * price field is not typeable, a switch to gold pricing is refused without a fresh rate (and sends nothing),
 * and a karat in the product facts that disagrees with the priced karat is flagged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { computeGoldUnitPrice } from '../../packages/shared/src/commerce/gold-price';

const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock('../../apps/admin/src/lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
}));
vi.mock('../../apps/admin/src/i18n/useT', () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}|${JSON.stringify(v)}` : k),
}));

import {
  GoldPricingCard,
  factsKaratMismatch,
} from '../../apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/GoldPricingCard';

const RATES = (stale = false, rate: number | null = 410000) => ({
  data: {
    settings: { enabled: true, roundingStep: 100 },
    rates: [
      { karat: 24, ratePerGram: rate ? Math.round((rate * 24) / 21) : null, stale },
      { karat: 21, ratePerGram: rate, stale },
      { karat: 18, ratePerGram: rate ? Math.round((rate * 18) / 21) : null, stale },
    ],
  },
});
const base = { id: 'p1', price: 100_000, pricingMode: 'gold_rate' as const, goldKarat: 21 };
const fact = (value: string) => ({ key: 'Karat', keyAr: '', value, valueAr: '', onCard: false });

function setup(rates: unknown) {
  apiGet.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith('/variants') ? { data: { variants: [] } } : rates)
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset();
});
afterEach(cleanup);

describe('GoldPricingCard', () => {
  it('previews the exact server price from the typed spec', async () => {
    setup(RATES());
    render(
      <GoldPricingCard
        storeId="s"
        facts={[]}
        onSaved={() => {}}
        product={{
          ...base,
          goldWeightMg: 4350,
          makingChargeType: 'per_gram',
          makingChargeValue: 15000,
          goldMarginBps: 700,
        }}
      />
    );
    const expected = computeGoldUnitPrice(
      {
        karat: 21,
        weightMg: 4350,
        makingChargeType: 'per_gram',
        makingChargeValue: 15000,
        marginBps: 700,
      },
      410000,
      100
    );
    await waitFor(() => expect(screen.getByText(/^preview\|/)).toBeTruthy());
    const text = screen.getByText(/^preview\|/).textContent ?? '';
    // formatPrice renders the integer with grouping; compare the digits only
    expect(text.replace(/\D/g, '')).toContain(String(expected.unitPrice / 100).replace('.', ''));
  });

  it('shows the current price but does not let it be typed', async () => {
    setup(RATES());
    render(<GoldPricingCard storeId="s" facts={[]} onSaved={() => {}} product={base} />);
    const price = screen.getByDisplayValue('1000.00') as HTMLInputElement;
    expect(price.disabled).toBe(true);
    expect(price.readOnly).toBe(true);
  });

  it('refuses to save without a fresh rate and sends nothing', async () => {
    setup(RATES(true));
    render(
      <GoldPricingCard
        storeId="s"
        facts={[]}
        onSaved={() => {}}
        product={{
          ...base,
          goldWeightMg: 4350,
          makingChargeType: 'per_gram',
          makingChargeValue: 0,
        }}
      />
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(apiPut).not.toHaveBeenCalled();
    expect((await screen.findAllByText('needFreshRate')).length).toBeGreaterThan(0);
  });

  it('sends the spec as integers (mg, piastres, bps), never a price', async () => {
    setup(RATES());
    apiPut.mockResolvedValue({ data: {}, error: null });
    render(
      <GoldPricingCard
        storeId="s"
        facts={[]}
        onSaved={() => {}}
        product={{
          ...base,
          goldWeightMg: 4350,
          makingChargeType: 'per_gram',
          makingChargeValue: 15000,
          goldMarginBps: 700,
        }}
      />
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    const [url, body] = apiPut.mock.calls[0] as [string, { product: Record<string, unknown> }];
    expect(url).toBe('/api/v1/stores/s/gold-rates/products/p1/pricing');
    expect(body.product).toEqual({
      pricingMode: 'gold_rate',
      karat: 21,
      weightMg: 4350,
      makingChargeType: 'per_gram',
      makingChargeValue: 15000,
      marginBps: 700,
    });
    expect(JSON.stringify(body)).not.toMatch(/"price"/);
  });

  it('flags a karat in the facts that differs from the priced karat', async () => {
    setup(RATES());
    render(
      <GoldPricingCard
        storeId="s"
        facts={[fact('18 karat gold')]}
        onSaved={() => {}}
        product={{ ...base, goldWeightMg: 4350 }}
      />
    );
    expect((await screen.findByText(/^factsMismatch\|/)).textContent).toContain('"karat":18');
  });
});

describe('factsKaratMismatch', () => {
  it('finds a different karat in English and Arabic facts, ignores a matching one', () => {
    expect(factsKaratMismatch([fact('18k')], 21)).toBe(18);
    expect(
      factsKaratMismatch(
        [{ key: 'k', keyAr: '', value: '', valueAr: 'ذهب عيار 24', onCard: false }],
        21
      )
    ).toBe(24);
    expect(factsKaratMismatch([fact('21 karat')], 21)).toBeNull();
    expect(factsKaratMismatch([fact('Weight 18 grams')], 21)).toBeNull();
    expect(factsKaratMismatch([], 21)).toBeNull();
  });

  it('store gold pricing OFF: a gold product can still be switched OFF (no dead end)', async () => {
    setup({ data: { ...RATES().data, settings: { enabled: false, roundingStep: 100 } } });
    apiPut.mockResolvedValue({ data: {} });
    render(
      <GoldPricingCard
        storeId="s"
        facts={[]}
        onSaved={() => {}}
        product={{ ...base, goldWeightMg: 4350 }}
      />
    );
    await screen.findByTestId('gold-store-off');
    expect(screen.getByTestId('gold-store-off').textContent).toBe('featureOffSaved');
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
  });
  it('store gold pricing OFF: a fixed-price product cannot be switched ON', async () => {
    setup({ data: { ...RATES().data, settings: { enabled: false, roundingStep: 100 } } });
    render(
      <GoldPricingCard
        storeId="s"
        facts={[]}
        onSaved={() => {}}
        product={{ id: 'p', price: 1, pricingMode: 'fixed' }}
      />
    );
    await screen.findByTestId('gold-store-off');
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('gold-store-off').textContent).toBe('featureOff');
  });
});
