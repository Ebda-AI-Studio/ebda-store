// @vitest-environment jsdom
/**
 * First run of the shipping rates tab (UX:SHP-1): with nothing priced the merchant is offered ONE price for all of
 * Egypt (fee + optional free-over) and one click saves it; once any rate exists the card is gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EGYPT_GOVERNORATES } from '@ebda/shared';

// Stable references: the editor's fetch effect depends on `t` and the toast functions.
const { apiGet, apiPut, t, toast } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  t: (k: string) => k,
  toast: { success: () => undefined, error: () => undefined },
}));

vi.mock('@/i18n/useT', () => ({ useT: () => t }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => toast,
}));
vi.mock('../../../../lib/api', () => ({
  apiGet,
  apiPut,
  apiDelete: vi.fn(),
  apiFetch: vi.fn(),
}));

import { AreaRateEditor } from './_components/AreaRateEditor';

const TOTAL_AREAS = EGYPT_GOVERNORATES.reduce((n, g) => n + g.areas.length, 0);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('shipping rates first run', () => {
  it('offers one price for all of Egypt and saves every area in one request', async () => {
    apiGet.mockResolvedValue({ data: { rates: [] }, error: null });
    apiPut.mockResolvedValue({ data: {}, error: null });
    render(<AreaRateEditor storeId="s1" />);

    const save = await screen.findByText('firstRunSave');
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing typed yet

    fireEvent.change(screen.getByPlaceholderText('firstRunFeePlaceholder'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByPlaceholderText('firstRunFreeOverPlaceholder'), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByText('firstRunSave'));

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = apiPut.mock.calls[0] as [
      string,
      { rates: Array<{ deliveryFee: number; freeShippingThreshold?: number; isActive: boolean }> },
    ];
    expect(url).toBe('/api/v1/stores/s1/shipping/area-rates/bulk');
    expect(body.rates).toHaveLength(TOTAL_AREAS);
    expect(body.rates.every(r => r.isActive && r.deliveryFee === 5000)).toBe(true);
    expect(body.rates.every(r => r.freeShippingThreshold === 100000)).toBe(true);
  });

  it('hides the card once any area already has a price', async () => {
    const first = EGYPT_GOVERNORATES[0];
    apiGet.mockResolvedValue({
      data: {
        rates: [
          {
            country: 'Egypt',
            countryAr: 'مصر',
            governorate: first.en,
            governorateAr: first.ar,
            area: first.areas[0].en,
            areaAr: first.areas[0].ar,
            deliveryFee: 3000,
            freeShippingThreshold: null,
            isActive: true,
            position: 0,
          },
        ],
      },
      error: null,
    });
    render(<AreaRateEditor storeId="s1" />);
    await screen.findByText('perGovernorateTitle');
    expect(screen.queryByTestId('shipping-first-run')).toBeNull();
  });
});
