// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { groupOrderLinesForDisplay } from '@ebda/shared';
import type { Order } from '@/lib/api';

let lang: 'en' | 'ar' = 'ar';
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('@/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (minor: number) => `${minor / 100} EGP`,
}));
vi.mock('@/hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (v: string | number) => String(v), numerals: 'latn' }),
}));

import { ReceiptPrinter } from './ReceiptPrinter';

const store = {
  name: 'Linen House',
  nameAr: 'بيت الكتان',
  timezone: 'Africa/Cairo',
  theme: {} as never,
};

const product = (name: string, nameAr: string) => ({ name, nameAr }) as never;

const order: Order = {
  id: 'order-1',
  orderNumber: '1043',
  status: 'pending',
  paymentStatus: 'unpaid',
  subtotal: 90000,
  shipping: 5000,
  discount: 0,
  total: 95000,
  payments: [{ provider: 'cod', method: null }],
  shippingAddress: {},
  createdAt: '2026-10-15T10:00:00Z',
  items: [
    {
      id: 'l1',
      productId: 'p1',
      quantity: 1,
      price: 45000,
      product: product('Linen abaya', 'عباية كتان'),
      variantName: 'Sand / M',
      personalisation: 'Sara',
    },
    {
      id: 'l2',
      productId: 'p2',
      quantity: 2,
      price: 22500,
      product: product('Scarf', 'طرحة'),
    },
  ],
};

const orderWithBundle: Order = {
  ...order,
  id: 'order-2',
  orderNumber: '1044',
  items: [
    ...order.items,
    {
      id: 'b1',
      productId: 'p3',
      quantity: 1,
      price: 10000,
      bundleGroupId: 'g1',
      bundleName: 'Gift box',
      bundleNameAr: 'علبة هدية',
    },
    {
      id: 'b2',
      productId: 'p4',
      quantity: 1,
      price: 8000,
      bundleGroupId: 'g1',
      bundleName: 'Gift box',
      bundleNameAr: 'علبة هدية',
    },
  ],
};

function mockMatchMedia(matches: Record<string, boolean>) {
  window.matchMedia = ((q: string) => ({
    matches: !!matches[q],
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  lang = 'ar';
  mockMatchMedia({});
  window.sessionStorage.clear();
});
afterEach(cleanup);

/** Ends the feed the way the browser does. jsdom has no AnimationEvent, so
 *  React listens for the webkit-prefixed name there; fire both. */
function finishFeed() {
  const paper = screen.getByTestId('receipt-paper');
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    fireEvent(paper, new Event(type, { bubbles: true }));
  }
}

describe('ReceiptPrinter', () => {
  it('cod receipt never says paid', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    finishFeed();
    expect(screen.queryByText(/تم الدفع|المدفوع|paid/i)).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/الدفع عند الاستلام/);
    expect(screen.getByText('الإجمالي')).toBeTruthy();

    cleanup();
    lang = 'en';
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    finishFeed();
    expect(screen.queryByText(/paid/i)).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Order placed, pay on delivery');
  });

  it('awaiting and pending receipts never say paid either', () => {
    for (const state of ['awaiting', 'pending', 'failed', 'verifying'] as const) {
      render(<ReceiptPrinter order={order} paymentState={state} store={store} />);
      finishFeed();
      expect(screen.queryByText(/تم الدفع|المدفوع/)).toBeNull();
      expect(screen.getByText('الإجمالي')).toBeTruthy();
      cleanup();
    }
  });

  it('paid receipt says total paid', () => {
    render(<ReceiptPrinter order={order} paymentState="paid" store={store} />);
    finishFeed();
    expect(screen.getByText('المدفوع')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('تم الدفع، طلبك اتأكد');
  });

  it('renders every line, bundle as one row, and the order number under the barcode', () => {
    render(<ReceiptPrinter order={orderWithBundle} paymentState="paid" store={store} />);
    expect(screen.getAllByTestId('receipt-line')).toHaveLength(
      groupOrderLinesForDisplay(orderWithBundle.items).length
    );
    expect(screen.getAllByTestId('receipt-line')).toHaveLength(3);
    expect(screen.getByText(/علبة هدية/)).toBeTruthy();
    expect(screen.getByText('180 EGP')).toBeTruthy(); // bundle = one summed row
    expect(screen.getByTestId('receipt-barcode-caption').textContent).toContain(
      orderWithBundle.orderNumber
    );
    expect(screen.getByTestId('receipt-barcode').getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the variant and personalisation under its line', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    const first = screen.getAllByTestId('receipt-line')[0];
    expect(within(first).getByText('Sand / M')).toBeTruthy();
    expect(first.textContent).toContain('✎ التخصيص: Sara');
    expect(within(first).getByText('عباية كتان', { exact: false })).toBeTruthy();
  });

  it('feeds first, then swaps the spinner for the final state on animationend', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBe('true');
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('printing');
    expect(screen.getByRole('status').textContent).toContain('بنطبع فاتورتك…');
    // The receipt is real text during the feed: nothing is hidden from screen readers.
    expect(screen.getByText('الإجمالي')).toBeTruthy();
    finishFeed();
    expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBeNull();
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('cod');
    expect(window.sessionStorage.getItem('receipt-printed:order-1')).toBe('1');
  });

  it('settles the status even if animationend never fires', () => {
    vi.useFakeTimers();
    try {
      render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
      expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('printing');
      act(() => {
        vi.advanceTimersByTime(2300);
      });
      expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('cod');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a bundle box as one item on the printer', () => {
    render(<ReceiptPrinter order={orderWithBundle} paymentState="paid" store={store} />);
    expect(screen.getByText('4 قطع')).toBeTruthy(); // 1 abaya + 2 scarves + 1 box, not its 2 lines
  });

  it('keeps the spinner after the feed while payment is still verifying', () => {
    const { rerender } = render(
      <ReceiptPrinter order={order} paymentState="verifying" store={store} />
    );
    finishFeed();
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('verifying');
    rerender(<ReceiptPrinter order={order} paymentState="paid" store={store} />);
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('paid');
  });

  it('reduced motion shows final state immediately', () => {
    mockMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    render(<ReceiptPrinter order={order} paymentState="paid" store={store} />);
    expect(screen.getByTestId('receipt-paper').className).not.toMatch(/feeding/);
    expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBeNull();
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('paid');
  });

  it('prints once per order: a reload shows the finished receipt', () => {
    window.sessionStorage.setItem('receipt-printed:order-1', '1');
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBeNull();
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('cod');
  });

  it('still prints when sessionStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
      expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBe('true');
    } finally {
      spy.mockRestore();
    }
  });

  it('while loading: printer with spinner, empty slot', () => {
    render(<ReceiptPrinter order={null} loading paymentState="cod" store={store} />);
    expect(screen.queryByTestId('receipt-paper')).toBeNull();
    expect(screen.getByTestId('receipt-status-icon').getAttribute('data-state')).toBe('printing');
  });

  it('names the payment method through the shared labels', () => {
    render(
      <ReceiptPrinter
        order={{ ...order, payments: [{ provider: 'paymob', method: 'card' }] }}
        paymentState="paid"
        store={store}
      />
    );
    expect(screen.getByText('بطاقة')).toBeTruthy();
  });
});
