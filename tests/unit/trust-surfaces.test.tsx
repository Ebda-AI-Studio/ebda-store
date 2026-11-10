// @vitest-environment jsdom
/**
 * S-02 (Qamar taste audit 2026-10-15, quality-bar § 8), the non-look part: the
 * trust facts Egyptian shoppers decide on sit where they decide, read from the
 * store, and NOTHING renders without the store's data.
 *  - PDP: one line under the buy button, "COD · returns within N days"
 *    (`TrustLine`: /payments/config + store.returnWindowDays), on the default
 *    PDP and the Dahab PDP.
 *  - Receipt: the delivery window (from the order's date) and a WhatsApp link.
 *  - Footer: a labelled WhatsApp contact line on the shared base and Dahab.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { all, parseFile } from './helpers/ast-statements';
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
  API_URL: 'http://api.test/api/v1',
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
import { fetchCodOffer } from '../../apps/web/src/lib/cod-offer';
import { useStorePaymentConfig } from '../../apps/web/src/hooks/useStorePaymentConfig';
import { renderToString } from 'react-dom/server';
import { ReceiptPrinter } from '../../apps/web/src/components/commerce/ReceiptPrinter';
import Base from '../../apps/web/src/templates/base/Footer';
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

const CODS = { name: 'Cash on Delivery', nameAr: 'الدفع عند الاستلام' };

describe('S-02: PDP trust line', () => {
  it('COD on and a 14-day window: "الدفع عند الاستلام · إرجاع خلال 14 يوم", on the FIRST render', () => {
    render(<TrustLine cod={CODS} />);
    const line = screen.getByTestId('pdp-trust-line');
    expect(line.textContent).toBe('الدفع عند الاستلام · إرجاع خلال 14 يوم');
    expect(line.querySelector('a[data-trust="returns"]')!.getAttribute('href')).toBe('/returns');
  });

  it('is in the server HTML, so nothing is inserted under the CTA after load (review I5)', () => {
    const html = renderToString(<TrustLine cod={CODS} />);
    expect(html).toContain('الدفع عند الاستلام');
    expect(html).toContain('data-trust="cod"');
  });

  it('reads the merchant COD name in English', () => {
    ctx.language = 'en';
    render(<TrustLine cod={CODS} />);
    expect(screen.getByTestId('pdp-trust-line').textContent).toBe(
      'Cash on Delivery · Returns within 14 days'
    );
  });

  it('COD off: only the return window', () => {
    render(<TrustLine cod={null} />);
    expect(screen.getByTestId('pdp-trust-line').textContent).toBe('إرجاع خلال 14 يوم');
  });

  it('no window declared, or returns not accepted: no returns part', () => {
    for (const days of [null, 0]) {
      ctx.store = { ...ctx.store, returnWindowDays: days };
      const { unmount } = render(<TrustLine cod={CODS} />);
      expect(
        screen.getByTestId('pdp-trust-line').querySelector('[data-trust="returns"]')
      ).toBeNull();
      unmount();
    }
  });

  it('no data at all (COD off or unknown, no window): renders nothing', () => {
    ctx.store = { ...ctx.store, returnWindowDays: null };
    const { container } = render(<TrustLine cod={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('never fetches on the client; the PDP reads COD on the server', () => {
    const tl = readFileSync(
      join(__dirname, '../../apps/web/src/components/commerce/TrustLine.tsx'),
      'utf8'
    );
    expect(tl).not.toMatch(/useStorePaymentConfig|api\.get|fetch\(/);
    const body = readFileSync(
      join(__dirname, '../../apps/web/src/app/products/[slug]/ProductDetailBody.tsx'),
      'utf8'
    );
    expect(body).toMatch(/fetchCodOffer\(store\)/);
    expect(body).toMatch(/codOffer=\{codOffer\}/);
  });

  it('fetchCodOffer reads the store config and never throws', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { cod: { displayName: 'COD', displayNameAr: null } },
            })
          )
      ) as never;
      expect(await fetchCodOffer({ id: 'store-a' })).toEqual({ name: 'COD', nameAr: null });
      globalThis.fetch = vi.fn(
        async () => new Response(JSON.stringify({ success: true, data: { cod: null } }))
      ) as never;
      expect(await fetchCodOffer({ id: 'store-a' })).toBeNull();
      globalThis.fetch = vi.fn(async () => {
        throw new Error('down');
      }) as never;
      expect(await fetchCodOffer({ id: 'store-a' })).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('sits under the buy button on the default PDP and the Dahab PDP', () => {
    // Structural (JSX AST): <TrustLine> is the very next element sibling after <DeliveryChip> in the same parent (only
    // whitespace / comment-only expressions between), and carries the expected `cod` expression. A text distance could be
    // satisfied by a neighbouring element or a comment.
    for (const [f, cod] of [
      ['apps/web/src/app/products/[slug]/ProductDetailClient.tsx', 'codOffer'],
      ['apps/web/src/templates/dahab/ProductDetail.tsx', 'p.codOffer ?? null'],
    ] as const) {
      const sf = parseFile(f);
      const chip = all(sf, ts.isJsxSelfClosingElement).filter(
        e => e.tagName.getText() === 'DeliveryChip'
      );
      const trust = all(sf, ts.isJsxSelfClosingElement).filter(
        e => e.tagName.getText() === 'TrustLine'
      );
      expect(chip, f).toHaveLength(1);
      expect(trust, f).toHaveLength(1);
      const parent = (n: ts.Node) => {
        let p: ts.Node = n;
        while (p.parent && !ts.isJsxElement(p.parent) && !ts.isJsxFragment(p.parent)) p = p.parent;
        return { child: p, container: p.parent as ts.JsxElement | ts.JsxFragment };
      };
      const c = parent(chip[0]!);
      const t = parent(trust[0]!);
      expect(t.container, `${f}: same parent`).toBe(c.container);
      const kids = [...c.container.children];
      const [ci, ti] = [kids.indexOf(c.child as never), kids.indexOf(t.child as never)];
      expect(ci, f).toBeGreaterThanOrEqual(0);
      expect(ti, f).toBeGreaterThan(ci);
      for (const k of kids.slice(ci + 1, ti)) {
        const blank = ts.isJsxText(k)
          ? k.text.trim() === ''
          : ts.isJsxExpression(k) && !k.expression;
        expect(blank, `${f}: nothing between the chip and the trust line`).toBe(true);
      }
      const attr = trust[0]!.attributes.properties.find(
        x => ts.isJsxAttribute(x) && x.name.getText() === 'cod'
      ) as ts.JsxAttribute;
      expect((attr.initializer as ts.JsxExpression).expression!.getText(), f).toBe(cod);
    }
  });
});

describe('concurrent /payments/config readers share one request (review M6)', () => {
  it('two mounts at once → one fetch; a later mount asks again', async () => {
    ctx.payment.mockResolvedValue({ success: true, data: { methods: {}, cod: CODS } });
    function Two() {
      useStorePaymentConfig();
      useStorePaymentConfig();
      return null;
    }
    const { unmount } = render(<Two />);
    await waitFor(() => expect(ctx.payment).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(ctx.payment).toHaveBeenCalledTimes(1);
    unmount();
    render(<Two />);
    await waitFor(() => expect(ctx.payment).toHaveBeenCalledTimes(2));
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
    // the ORDER's zone (review I4; behaviour in receipt-delivery-zone.test.tsx)
    expect(src).toMatch(/address: order \? \(order\.shippingAddress \?\? \{\}\) : null/);
    expect(src).toMatch(/deliveryWindow=\{deliveryWindow\}/);
    expect(src).toMatch(/whatsappHref=\{whatsappHref\}/);
  });
});

const FOOTERS = {
  base: Base,
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
