// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const ctx = vi.hoisted(() => ({
  store: {
    id: 'store-a',
    name: 'Shop',
    theme: {},
    settings: { acceptedPaymentMethods: ['Visa', 'Mastercard'] },
  },
  language: 'en',
  payment: vi.fn(),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, layout: {} }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  translations: {},
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../apps/web/src/contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => false }),
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: [{ id: 'line', productId: 'p1', name: 'Ring', price: 10000, quantity: 1 }],
    bundles: [],
    itemCount: 1,
    total: 10000,
    isReady: true,
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    get: (path: string) =>
      path === '/payments/config' ? ctx.payment() : Promise.resolve({ success: true, data: {} }),
    // The cart's automatic-promotion preview (none here).
    post: () => Promise.resolve({ success: true, data: { promotion: null } }),
  },
}));
vi.mock('../../apps/web/src/hooks/useTemplateComponents', () => ({
  useTemplateComponents: () => ({ components: null }),
}));
vi.mock('../../apps/web/src/hooks/useLastListing', () => ({ useLastListing: () => '/products' }));
vi.mock('../../apps/web/src/components', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../apps/web/src/components/CartRecommendations', () => ({
  CartRecommendations: () => null,
}));
vi.mock('@ebda/ui', async original => ({
  ...(await original<Record<string, unknown>>()),
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));

import CartClient from '../../apps/web/src/app/cart/CartClient';
import Footer from '../../apps/web/src/templates/dahab/Footer';
import OrderSummary from '../../apps/web/src/templates/dahab/OrderSummary';

const surfaces = [
  ['cart', () => <CartClient />],
  [
    'Dahab footer',
    () => <Footer branding={{ name: 'Shop' }} contact={{}} socials={{}} hidePoweredBy />,
  ],
  ['Dahab summary', () => <OrderSummary subtotal={10000} total={10000} />],
] as const;
const cod = {
  success: true,
  data: {
    methods: {},
    cod: { displayName: 'Cash on Delivery', displayNameAr: 'الدفع عند الاستلام' },
  },
};
beforeEach(() => {
  ctx.language = 'en';
  ctx.store.id = 'store-a';
  ctx.payment.mockReset();
  ctx.payment.mockResolvedValue(cod);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

for (const [name, Surface] of surfaces)
  describe(name, () => {
    it.each(['en', 'ar'])(
      'shows only configured COD in %s despite legacy card override',
      async language => {
        ctx.language = language;
        const view = render(<Surface />);
        await waitFor(() =>
          expect(view.container.textContent).toContain(
            language === 'ar' ? 'الدفع عند الاستلام' : 'Cash on Delivery'
          )
        );
        expect(view.container.textContent).not.toMatch(/Visa|Mastercard|Meeza|Fawry|InstaPay/);
      }
    );
    it('claims no payment method while configuration is pending', () => {
      ctx.payment.mockReturnValue(new Promise(() => {}));
      const view = render(<Surface />);
      expect(view.container.textContent).not.toMatch(
        /Visa|Mastercard|Meeza|Fawry|InstaPay|Cash on Delivery/
      );
    });
    it('claims no method after a failed request and one failed retry', async () => {
      vi.useFakeTimers();
      ctx.payment.mockRejectedValue(new Error('offline'));
      const view = render(<Surface />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(ctx.payment).toHaveBeenCalledTimes(2);
      expect(view.container.textContent).not.toMatch(
        /Visa|Mastercard|Meeza|Fawry|InstaPay|Cash on Delivery/
      );
    });
    it('hides a loaded tenant capability while another tenant is pending', async () => {
      const view = render(<Surface />);
      await waitFor(() => expect(view.container.textContent).toContain('Cash on Delivery'));
      ctx.payment.mockReturnValue(new Promise(() => {}));
      ctx.store.id = 'store-b';
      view.rerender(<Surface />);
      expect(view.container.textContent).not.toContain('Cash on Delivery');
    });
    it('does not mistake malformed manual configuration for available COD', async () => {
      ctx.payment.mockResolvedValue({ success: true, data: { cod: 'enabled' } });
      const view = render(<Surface />);
      await act(async () => {});
      expect(view.container.textContent).not.toContain('Cash on Delivery');
    });
    it.each(['en', 'ar'])('shows only enabled Meeza and InstaPay in %s', async language => {
      ctx.language = language;
      ctx.payment.mockResolvedValue({
        success: true,
        data: { methods: { paymob: [{ code: 'meeza' }, { code: 'constructor' }] }, instapay: {} },
      });
      const view = render(<Surface />);
      await waitFor(() =>
        expect(view.container.textContent).toContain(language === 'ar' ? 'ميزة' : 'Meeza')
      );
      expect(view.container.textContent).toContain(language === 'ar' ? 'إنستاباي' : 'InstaPay');
      expect(view.container.textContent).not.toMatch(
        /Visa|Mastercard|Fawry|Cash on Delivery|Card|بطاقة/
      );
    });
    it('drops prior tenant methods immediately and ignores its late response', async () => {
      let finish: (value: unknown) => void = () => {};
      ctx.payment.mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve;
        })
      );
      const view = render(<Surface />);
      ctx.store.id = 'store-b';
      view.rerender(<Surface />);
      await waitFor(() => expect(view.container.textContent).toContain('Cash on Delivery'));
      await act(async () => {
        finish({ success: true, data: { methods: { paymob: [{ code: 'card' }] } } });
      });
      expect(view.container.textContent).not.toContain('Card');
    });
  });
