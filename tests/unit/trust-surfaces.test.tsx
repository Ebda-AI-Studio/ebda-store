// @vitest-environment jsdom
/**
 * S-02 (Qamar taste audit 2026-10-15, quality-bar § 8), the non-look part: the
 * trust facts Egyptian shoppers decide on sit where they decide, read from the
 * store, and NOTHING renders without the store's data.
 *  - PDP: one line under the buy button, "COD · returns within N days"
 *    (`TrustLine`: /payments/config + store.returnWindowDays), on the default
 *    PDP and the Dahab PDP.
 *  - Receipt: the delivery window (from the order's date) and a WhatsApp link.
 *  - Footer: a labelled WhatsApp contact line on all 5 skins + Dahab.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { localizeDigits } from '@ebda/shared';
import type { Order } from '../../apps/web/src/lib/api';

const ctx = vi.hoisted(() => ({
  language: 'ar' as 'ar' | 'en',
  store: {
    id: 'store-a',
    name: 'Shop',
    theme: {},
    settings: {},
    returnWindowDays: 14 as number | null,
  },
  payment: vi.fn(),
}));
const langMock = vi.hoisted(() => () => ({
  translations: {},
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));
const storeMock = vi.hoisted(() => () => ({
  useStore: () => ({ store: ctx.store, layout: {} }),
  useStoreUrl: () => (p: string) => p,
}));
const numeralsMock = vi.hoisted(() => () => ({
  useStoreNumerals: () => 'latn',
  useNumerals: () => ({
    localize: (v: string | number) => localizeDigits(v, 'latn'),
    numerals: 'latn',
  }),
}));
const apiMock = vi.hoisted(() => () => ({
  api: {
    get: (path: string) =>
      path === '/payments/config' ? ctx.payment() : Promise.resolve({ success: false }),
  },
}));
vi.mock('@/contexts/LanguageContext', langMock);
vi.mock('../../apps/web/src/contexts/LanguageContext', langMock);
vi.mock('@/contexts/StoreContext', storeMock);
vi.mock('../../apps/web/src/contexts/StoreContext', storeMock);
vi.mock('@/hooks/useNumerals', numeralsMock);
vi.mock('../../apps/web/src/hooks/useNumerals', numeralsMock);
vi.mock('@/lib/api', apiMock);
vi.mock('../../apps/web/src/lib/api', apiMock);

import { TrustLine } from '../../apps/web/src/components/commerce/TrustLine';
import { ReceiptPrinter } from '../../apps/web/src/components/commerce/ReceiptPrinter';
import Minimal from '../../apps/web/src/templates/minimal/Footer';
import Classic from '../../apps/web/src/templates/classic/Footer';
import Modern from '../../apps/web/src/templates/modern/Footer';
import Elegant from '../../apps/web/src/templates/elegant/Footer';
import Bold from '../../apps/web/src/templates/bold/Footer';
import Dahab from '../../apps/web/src/templates/dahab/Footer';

const cod = {
  success: true,
  data: {
    methods: {},
    cod: { displayName: 'Cash on Delivery', displayNameAr: 'الدفع عند الاستلام' },
  },
};
const noCod = { success: true, data: { methods: {}, cod: null } };

beforeEach(() => {
  ctx.language = 'ar';
  ctx.store = { ...ctx.store, returnWindowDays: 14 };
  ctx.payment.mockReset();
});
afterEach(cleanup);

describe('S-02: PDP trust line', () => {
  it('COD on and a 14-day window: "الدفع عند الاستلام · إرجاع خلال 14 يومًا"', async () => {
    ctx.payment.mockResolvedValue(cod);
    render(<TrustLine />);
    const line = await screen.findByTestId('pdp-trust-line');
    await waitFor(() => expect(line.querySelector('[data-trust="cod"]')).not.toBeNull());
    expect(line.textContent).toBe('الدفع عند الاستلام · إرجاع خلال 14 يومًا');
    expect(line.querySelector('a[data-trust="returns"]')!.getAttribute('href')).toBe('/returns');
  });

  it('reads the merchant COD name in English', async () => {
    ctx.language = 'en';
    ctx.payment.mockResolvedValue(cod);
    render(<TrustLine />);
    await waitFor(() =>
      expect(screen.getByTestId('pdp-trust-line').textContent).toBe(
        'Cash on Delivery · Returns within 14 days'
      )
    );
  });

  it('COD off: only the return window', async () => {
    ctx.payment.mockResolvedValue(noCod);
    render(<TrustLine />);
    await waitFor(() => expect(ctx.payment).toHaveBeenCalled());
    expect(screen.getByTestId('pdp-trust-line').textContent).toBe('إرجاع خلال 14 يومًا');
  });

  it('no window declared, or returns not accepted: no returns part', async () => {
    ctx.payment.mockResolvedValue(cod);
    for (const days of [null, 0]) {
      ctx.store = { ...ctx.store, returnWindowDays: days };
      const { unmount } = render(<TrustLine />);
      const line = await screen.findByTestId('pdp-trust-line');
      expect(line.querySelector('[data-trust="returns"]')).toBeNull();
      unmount();
    }
  });

  it('no data at all (COD off or unknown, no window): renders nothing', async () => {
    ctx.store = { ...ctx.store, returnWindowDays: null };
    ctx.payment.mockResolvedValue({ success: false });
    const { container } = render(<TrustLine />);
    await waitFor(() => expect(ctx.payment).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('sits under the buy button on the default PDP and the Dahab PDP', () => {
    for (const f of [
      'apps/web/src/app/products/[slug]/ProductDetailClient.tsx',
      'apps/web/src/templates/dahab/ProductDetail.tsx',
    ]) {
      const src = readFileSync(join(__dirname, '../..', f), 'utf8');
      const chip = src.indexOf('<DeliveryChip');
      expect(chip, f).toBeGreaterThan(0);
      const trust = src.indexOf('<TrustLine />');
      expect(trust, f).toBeGreaterThan(chip);
      expect(trust - chip, f).toBeLessThan(400);
    }
  });
});

const order = {
  id: 'o1',
  orderNumber: 'ORD-1',
  status: 'pending',
  paymentStatus: 'unpaid',
  total: 1000,
  payments: [{ provider: 'cod', method: null }],
  createdAt: '2026-10-15T10:00:00Z',
  items: [{ id: 'l1', productId: 'p1', quantity: 1, price: 1000, product: { name: 'Ring' } }],
} as unknown as Order;
const receiptStore = { name: 'Shop', timezone: 'Africa/Cairo' };

describe('S-02: the receipt repeats the delivery window and offers WhatsApp', () => {
  it('renders both when the store has them', () => {
    render(
      <ReceiptPrinter
        order={order}
        paymentState="cod"
        store={receiptStore}
        deliveryWindow={{ from: 'السبت 17 أكتوبر', to: 'الاثنين 19 أكتوبر' }}
        whatsappHref="https://wa.me/201012345678?text=x"
      />
    );
    expect(screen.getByTestId('receipt-delivery-window').textContent).toBe(
      'السبت 17 أكتوبر – الاثنين 19 أكتوبر'
    );
    const wa = screen.getByTestId('receipt-whatsapp');
    expect(wa.getAttribute('href')).toBe('https://wa.me/201012345678?text=x');
    expect(wa.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('one day prints once; a failed payment gets no window', () => {
    const { rerender } = render(
      <ReceiptPrinter
        order={order}
        paymentState="paid"
        store={receiptStore}
        deliveryWindow={{ from: 'السبت', to: 'السبت' }}
      />
    );
    expect(screen.getByTestId('receipt-delivery-window').textContent).toBe('السبت');
    rerender(
      <ReceiptPrinter
        order={order}
        paymentState="failed"
        store={receiptStore}
        deliveryWindow={{ from: 'السبت', to: 'السبت' }}
      />
    );
    expect(screen.queryByTestId('receipt-delivery-window')).toBeNull();
  });

  it('renders neither without the store data', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={receiptStore} />);
    expect(screen.queryByTestId('receipt-delivery-window')).toBeNull();
    expect(screen.queryByTestId('receipt-whatsapp')).toBeNull();
  });

  it('the success page feeds both from the store (order date clock, order-question link)', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/app/checkout/success/SuccessClient.tsx'),
      'utf8'
    );
    expect(src).toMatch(
      /useDeliveryWindow\(\{\s*from: order \? new Date\(order\.createdAt\) : null/
    );
    expect(src).toMatch(/useOrderQuestionHref\(order\?\.orderNumber\)/);
    expect(src).toMatch(/deliveryWindow=\{deliveryWindow\}/);
    expect(src).toMatch(/whatsappHref=\{whatsappHref\}/);
  });
});

const FOOTERS = {
  minimal: Minimal,
  classic: Classic,
  modern: Modern,
  elegant: Elegant,
  bold: Bold,
  dahab: Dahab,
};
describe.each(Object.entries(FOOTERS))('S-02: %s footer WhatsApp line', (_n, Footer) => {
  const base = {
    branding: { name: 'Shop' } as never,
    socials: {},
    hidePoweredBy: true,
  };
  it('names the store WhatsApp with a normalised wa.me link', () => {
    ctx.payment.mockResolvedValue({ success: false });
    const { container } = render(<Footer {...base} contact={{ whatsapp: '010 1234 5678' }} />);
    const a = container.querySelector('a[data-footer-whatsapp]')!;
    expect(a.getAttribute('href')).toBe('https://wa.me/201012345678');
    expect(a.textContent).toContain('واتساب');
    expect(a.textContent).toContain('010 1234 5678');
  });
  it('renders nothing without a number', () => {
    ctx.payment.mockResolvedValue({ success: false });
    const { container } = render(<Footer {...base} contact={{ phone: '0223456789' }} />);
    expect(container.querySelector('[data-footer-whatsapp]')).toBeNull();
  });
});
