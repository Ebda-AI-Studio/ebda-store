// @vitest-environment jsdom
/**
 * C-01 on the merchant path (W1a fix round): a payment link for a product with
 * variants names the size. Picking a sized product shows a size select; the
 * link cannot be sent until a size is chosen, and the request carries its
 * variantId (the API answers VARIANT_REQUIRED without one).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string) => key;
  return { useT: () => t };
});

import { PaymentLinkTab } from './PaymentLinkTab';

const PRODUCT = { id: 'p-abaya', name: 'Abaya', price: 50000, sku: null, hasVariants: true };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PaymentLinkTab — sized products', () => {
  it('shows a size select, blocks send until a size is chosen, then sends the variantId', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('/variants')
        ? {
            data: {
              variants: [
                { id: 'v-m', title: 'M', titleAr: 'وسط', price: 52000, isActive: true },
                { id: 'v-off', title: 'XL', price: null, isActive: false },
              ],
            },
          }
        : { data: { products: [PRODUCT] } }
    );
    apiPost.mockResolvedValue({ data: null, error: null });

    render(<PaymentLinkTab storeId="s1" />);
    await act(async () => {});
    // the phone field starts with the region's calling code
    const phone = [...document.querySelectorAll('input')].find(i => i.value.startsWith('+'))!;
    fireEvent.change(phone, { target: { value: '+201012345678' } });
    // pick the product from the suggestions
    await act(async () => {
      fireEvent.click(await screen.findByText('Abaya'));
    });

    const select = (await screen.findByLabelText(/variantLabel/)) as HTMLSelectElement;
    // inactive variants are not offered
    expect([...select.options].map(o => o.value)).toEqual(['', 'v-m']);
    const send = screen
      .getAllByRole('button')
      .find(b => /send/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'v-m' } });
    await act(async () => {
      fireEvent.click(send);
    });
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][1].items).toEqual([
      { productId: 'p-abaya', variantId: 'v-m', quantity: 1 },
    ]);
  });
});
