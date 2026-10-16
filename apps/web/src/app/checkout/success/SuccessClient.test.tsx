// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// The success page around the receipt (Task 10 fix round 1): while the receipt
// printer renders, it owns the confirmation, so the hero icon and the COD banner
// step aside; when the order cannot be loaded there is no receipt, and they return.

let params = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => params }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock('../../../components', () => ({
  MinimalChrome: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../templates/shared/WaMeButtons', () => ({
  WaMeCodConfirmButton: () => null,
  useOrderQuestionHref: () => null,
}));
vi.mock('../../../components/commerce/DeliveryChip', () => ({ useDeliveryWindow: () => null }));
vi.mock('./InstapayCard', () => ({ InstapayCard: () => null }));
vi.mock('./FawryReferenceCard', () => ({ FawryReferenceCard: () => null }));
vi.mock('../../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { name: 'S', timezone: 'Africa/Cairo', theme: {} } }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../../contexts/CartContext', () => ({ useCart: () => ({ clearCart: () => {} }) }));
vi.mock('../../../components/MarketingPixels', () => ({ trackPurchase: () => {} }));
vi.mock('../../../lib/purchase-pixel-guard', () => ({ firePurchasePixelOnce: () => {} }));
vi.mock('../../../hooks/useLastListing', () => ({ useLastListing: () => '/products' }));
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_en: string, ar: string) => ar }),
}));
vi.mock('../../../components/commerce/ReceiptPrinter', () => ({
  ReceiptPrinter: ({ order, loading }: { order: unknown; loading: boolean }) => (
    <div data-testid="receipt" data-loading={String(loading)} data-has-order={String(!!order)} />
  ),
}));
const getOrder = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    getOrder: (...a: unknown[]) => getOrder(...a),
    verifyOrderPayment: vi.fn(),
  },
}));

import SuccessClient from './SuccessClient';

const order = {
  id: 'o1',
  orderNumber: '1043',
  status: 'pending',
  paymentStatus: 'unpaid',
  total: 1000,
  items: [],
  shippingAddress: {},
  createdAt: '2026-10-15T10:00:00Z',
};

beforeEach(() => {
  params = new URLSearchParams('orderId=o1&cod=1');
  getOrder.mockReset();
});
afterEach(cleanup);

describe('SuccessClient hero vs receipt', () => {
  it('receipt renders: no hero icon, no duplicated COD banner; title and sub-copy stay', async () => {
    getOrder.mockResolvedValue({ success: true, data: { order } });
    render(<SuccessClient />);
    await waitFor(() =>
      expect(screen.getByTestId('receipt').getAttribute('data-has-order')).toBe('true')
    );
    expect(screen.queryByTestId('success-hero-icon')).toBeNull();
    expect(screen.queryByTestId('success-cod-banner')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('شكراً لطلبك!');
    expect(screen.getByText('تم تقديم طلبك. يرجى تجهيز المبلغ عند استلام الطلب.')).toBeTruthy();
  });

  it('while the order loads the printer is up and the hero stays hidden', () => {
    getOrder.mockReturnValue(new Promise(() => {}));
    render(<SuccessClient />);
    expect(screen.getByTestId('receipt').getAttribute('data-loading')).toBe('true');
    expect(screen.queryByTestId('success-hero-icon')).toBeNull();
    expect(screen.queryByTestId('success-cod-banner')).toBeNull();
  });

  it('order fails to load: no receipt, so the hero icon and COD banner come back', async () => {
    getOrder.mockRejectedValue(new Error('network'));
    render(<SuccessClient />);
    await waitFor(() => expect(screen.getByTestId('success-hero-icon')).toBeTruthy());
    expect(screen.queryByTestId('receipt')).toBeNull();
    expect(screen.getByTestId('success-cod-banner')).toBeTruthy();
    expect(screen.getByText('تم استلام طلبك. يمكنك متابعة حالته في أي وقت من حسابك.')).toBeTruthy();
  });
});
