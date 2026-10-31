// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { groupOrderLinesForDisplay, localizeDigits } from '@ebda/shared';
import type { Order } from '@/lib/api';

let lang: 'en' | 'ar' = 'ar';
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
// The real useLocalePrice runs (shared formatPrice); only the store's digit
// choice is stubbed, so one test can switch a store to Arabic-Indic.
let numerals = 'latn' as const;
vi.mock('@/hooks/useNumerals', () => ({
  useStoreNumerals: () => numerals,
  useNumerals: () => ({
    localize: (v: string | number) => localizeDigits(v, numerals),
    numerals,
  }),
}));

import { ReceiptPrinter } from './ReceiptPrinter';
import styles from './ReceiptPrinter.module.css';

const store = {
  name: 'Linen House',
  nameAr: 'بيت الكتان',
  timezone: 'Africa/Cairo',
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
      variantName: 'Sand / M / 54 cm',
      variantNameAr: 'رملي / M / 54 سم',
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
  numerals = 'latn';
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
  it('prints the delivery pick (Ruling B4-7) in both locales, and nothing without one', () => {
    const pick = 'الثلاثاء 3 نوفمبر، غدا 12-2 (12:00 م–2:00 م)';
    render(
      <ReceiptPrinter order={{ ...order, deliveryLine: pick }} paymentState="cod" store={store} />
    );
    finishFeed();
    expect(screen.getByTestId('receipt-delivery-pick').textContent).toBe(pick);
    expect(screen.getByText('التوصيل')).toBeTruthy();

    cleanup();
    lang = 'en';
    render(
      <ReceiptPrinter
        order={{ ...order, deliveryLine: 'Tue 3 Nov, Lunch (12:00 PM–2:00 PM)' }}
        paymentState="cod"
        store={store}
      />
    );
    finishFeed();
    expect(screen.getByText('Delivery')).toBeTruthy();

    cleanup();
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    finishFeed();
    expect(screen.queryByTestId('receipt-delivery-pick')).toBeNull();
  });

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
    expect(screen.getByRole('status').textContent).toContain('اتدفع، طلبك اتأكد');
  });

  it('renders every line, bundle as one row, and the order number at the foot', () => {
    render(<ReceiptPrinter order={orderWithBundle} paymentState="paid" store={store} />);
    expect(screen.getAllByTestId('receipt-line')).toHaveLength(
      groupOrderLinesForDisplay(orderWithBundle.items).length
    );
    expect(screen.getAllByTestId('receipt-line')).toHaveLength(3);
    expect(screen.getByText(/علبة هدية/)).toBeTruthy();
    // bundle = one row priced at the box total (100 + 80), never its components
    expect(screen.getAllByTestId('receipt-line')[2].textContent).toMatch(/180/);
    expect(screen.getByTestId('receipt-order-number').textContent).toContain(
      orderWithBundle.orderNumber
    );
  });

  it('draws a real Code 128 barcode, in the store-chosen shape, always LTR', () => {
    const { container, rerender } = render(
      <ReceiptPrinter order={order} paymentState="paid" store={store} />
    );
    expect(container.querySelector('bdi[dir="ltr"] svg[aria-label="1043"]')).toBeTruthy();
    expect(screen.getByTestId('receipt-barcode').dataset.shape).toBe('plain');
    expect(container.querySelector('mask')).toBeNull();
    rerender(
      <ReceiptPrinter
        order={order}
        paymentState="paid"
        store={{ ...store, settings: { receiptBarcodeShape: 'palm' } }}
      />
    );
    expect(screen.getByTestId('receipt-barcode').dataset.shape).toBe('palm');
    expect(container.querySelector('mask')).toBeTruthy();
    // the printed caption is untouched by the shape
    expect(screen.getByTestId('receipt-order-number').textContent).toBe('#1043');
  });

  it('shape "off" draws no barcode but keeps the caption', () => {
    render(
      <ReceiptPrinter
        order={order}
        paymentState="paid"
        store={{ ...store, settings: { receiptBarcodeShape: 'off' } }}
      />
    );
    expect(screen.queryByTestId('receipt-barcode')).toBeNull();
    expect(screen.getByTestId('receipt-order-number').textContent).toBe('#1043');
  });

  it('shows the variant and personalisation under its line', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    const first = screen.getAllByTestId('receipt-line')[0];
    // Arabic snapshot in Arabic, each option value isolated in its own <bdi> (F8).
    const bdis = Array.from(first.querySelectorAll('bdi')).map(b => b.textContent);
    expect(bdis).toEqual(expect.arrayContaining(['رملي', 'M', '54 سم']));
    expect(first.textContent).toContain('رملي · M · 54 سم');
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

  // (The printer's item count, and its bundle-counts-once rule, left with P2-5: the head carries
  // the payment status only; see "printer head carries the status only".)

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

  it('sets only Western digit runs in mono: the payment label and Free use the body font', () => {
    expect(styles.mono).toBeTruthy();
    render(<ReceiptPrinter order={{ ...order, shipping: 0 }} paymentState="cod" store={store} />);
    const label = screen.getByTestId('receipt-payment-label');
    expect(label.textContent).toBe('الدفع عند الاستلام');
    expect(label.className).not.toContain(styles.mono);
    expect(label.closest(`.${styles.mono}`)).toBeNull();
    expect(label.querySelector(`.${styles.mono}`)).toBeNull();
    const free = screen.getByText('مجاني');
    expect(free.closest(`.${styles.mono}`)).toBeNull();
    // every mono run on the receipt is Latin digits / order-number only
    for (const el of document.querySelectorAll(`.${styles.mono}`)) {
      expect(el.textContent).not.toMatch(/[؀-ۿ]/);
    }
  });

  it('crossfades the status: the old line fades out over the new one, then leaves', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(screen.queryByTestId('receipt-status-leaving')).toBeNull(); // no fade on first paint
    finishFeed();
    const leaving = screen.getByTestId('receipt-status-leaving');
    expect(leaving.getAttribute('aria-hidden')).toBe('true');
    expect(leaving.className).toContain(styles.statusOut);
    expect(leaving.textContent).toContain('بنطبع فاتورتك…');
    const current = screen.getByTestId('receipt-status-current');
    expect(current.className).toContain(styles.statusIn);
    expect(current.textContent).toContain('طلبك اتسجل، الدفع عند الاستلام');
    fireEvent(leaving, new Event('animationend', { bubbles: true }));
    fireEvent(leaving, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(screen.queryByTestId('receipt-status-leaving')).toBeNull();
  });

  it('reduced motion never mounts a fading status line', () => {
    mockMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(screen.queryByTestId('receipt-status-leaving')).toBeNull();
    expect(screen.getByTestId('receipt-status-current').className).not.toContain(styles.statusIn);
  });

  it('wallet: amount due shows on a cod order and is hidden once paid', () => {
    const walletOrder = { ...order, walletAmount: 20000 };
    render(<ReceiptPrinter order={walletOrder} paymentState="cod" store={store} />);
    expect(screen.getByText('المبلغ المستحق')).toBeTruthy();
    expect(screen.getByText('من المحفظة')).toBeTruthy();
    cleanup();
    render(<ReceiptPrinter order={walletOrder} paymentState="paid" store={store} />);
    expect(screen.queryByText('المبلغ المستحق')).toBeNull();
    expect(screen.getByText('من المحفظة')).toBeTruthy();
  });

  it('store and bundle names fall back across languages, never blank', () => {
    const blankBundle: Order = {
      ...orderWithBundle,
      items: orderWithBundle.items.map(i => (i.bundleGroupId ? { ...i, bundleNameAr: '  ' } : i)),
    };
    render(
      <ReceiptPrinter order={blankBundle} paymentState="paid" store={{ ...store, nameAr: '' }} />
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Linen House');
    expect(screen.getAllByTestId('receipt-line')[2].textContent).toContain('Gift box');
    cleanup();
    lang = 'en';
    render(
      <ReceiptPrinter
        order={{
          ...orderWithBundle,
          items: orderWithBundle.items.map(i => (i.bundleGroupId ? { ...i, bundleName: '' } : i)),
        }}
        paymentState="paid"
        store={{ ...store, name: ' ' }}
      />
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('بيت الكتان');
    expect(screen.getAllByTestId('receipt-line')[2].textContent).toContain('علبة هدية');
  });

  it('Western digits only (DIGITS-1): money and the order number carry no Arabic-Indic digit', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    const total = screen.getByTestId('receipt-total').textContent ?? '';
    expect(total).toMatch(/950/);
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/);
    expect(screen.getByTestId('receipt-order-number').textContent).toBe('#1043');
  });

  it('english: canonical variant title, and the date reads day month year', () => {
    lang = 'en';
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    const first = screen.getAllByTestId('receipt-line')[0];
    expect(first.textContent).toContain('Sand · M · 54 cm');
    expect(document.body.textContent).toContain('15 Oct 2026');
    expect(document.body.textContent).not.toContain('10/15/2026');
  });

  it('prints the order number once on the paper (the foot), no duplicate meta row', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    const paper = screen.getByTestId('receipt-paper');
    expect(within(paper).getAllByText('#1043')).toHaveLength(1);
    expect(within(paper).getAllByText('رقم الطلب')).toHaveLength(1);
    expect(screen.getByTestId('receipt-order-number').textContent).toBe('#1043');
  });

  it('a bubbling animationend from inside the leaving status line does not end the crossfade', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    finishFeed();
    const leaving = screen.getByTestId('receipt-status-leaving');
    const child = leaving.querySelector('span')!;
    fireEvent(child, new Event('animationend', { bubbles: true }));
    fireEvent(child, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(screen.getByTestId('receipt-status-leaving')).toBeTruthy();
    fireEvent(leaving, new Event('animationend', { bubbles: true }));
    fireEvent(leaving, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(screen.queryByTestId('receipt-status-leaving')).toBeNull();
  });
});

// W3 receipt polish (decision (d) supersedes B0-3; T-04, M-05, K-07).
describe('receipt W3', () => {
  // Ruling B1-68b: supersedes the barcode half of B1-68. The barcode is a decode-gated Code 128
  // (feat/shaped-barcodes), so S-04's "must work, or it is removed" is met; the large readable
  // order number stays under it.
  it('S-04: a real scannable barcode plus one large human-readable order number', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(screen.getByTestId('receipt-barcode')).toBeTruthy();
    const n = screen.getByTestId('receipt-order-number');
    expect(n.textContent).toBe('#1043');
    // IA-14: readable, not huge (text-2xl monospace was hard to read out to a courier)
    expect(n.className).toContain('text-xl');
    expect(n.className).not.toMatch(/tracking-\[/);
  });
  it('T-04: money is the body face with tabular figures; mono is only the order number', () => {
    render(<ReceiptPrinter order={order} paymentState="paid" store={store} />);
    for (const el of document.querySelectorAll(`.${styles.mono}`))
      expect(el.textContent).toMatch(/^#?1043$/);
    expect(document.querySelector('[class*="uppercase"]')).toBeNull();
  });
  it('M-05: a tap on the paper ends the feed at once', () => {
    render(
      <ReceiptPrinter order={{ ...order, id: 'order-tap' }} paymentState="cod" store={store} />
    );
    expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBe('true');
    fireEvent.click(screen.getByTestId('receipt-paper'));
    expect(screen.getByTestId('receipt-paper').getAttribute('data-feeding')).toBeNull();
  });
  it('K-07: receiptStyle framed drops the device slab (no shadow, framed housing)', () => {
    const { container } = render(
      <ReceiptPrinter
        order={order}
        paymentState="cod"
        store={{ ...store, theme: { receiptStyle: 'framed' } } as never}
      />
    );
    const section = container.querySelector('section')!;
    expect(section.getAttribute('data-receipt')).toBe('framed');
    expect(container.innerHTML).not.toContain('shadow-lg');
  });
  it('K-07: without the token the device housing is unchanged', () => {
    const { container } = render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(container.querySelector('section')!.hasAttribute('data-receipt')).toBe(false);
    expect(container.innerHTML).toContain('shadow-lg');
  });
});

// IA-14 (independent audit): the number and the total each printed twice (printer
// head and paper); the number set huge in one unbroken monospace run.
describe('receipt IA-14', () => {
  it('groups a prefixed order number for reading out, keeps the full value for readers', async () => {
    const { groupOrderNumber } = await import('./ReceiptPrinter');
    expect(groupOrderNumber('ORD-TMZRB9-IR5JY')).toBe('TMZRB9 · IR5JY');
    expect(groupOrderNumber('1043')).toBe('1043');
    render(
      <ReceiptPrinter
        order={{ ...order, orderNumber: 'ORD-TMZRB9-IR5JY' }}
        paymentState="cod"
        store={store}
      />
    );
    const n = screen.getByTestId('receipt-order-number');
    // a11y re-audit P2-N7: aria-label is prohibited on a <p>; the grouped form is shown
    // (aria-hidden) and the full value is read from an sr-only span.
    expect(n.hasAttribute('aria-label')).toBe(false);
    expect(n.querySelector('[aria-hidden="true"]')!.textContent).toBe('#TMZRB9 · IR5JY');
    expect(n.querySelector('.sr-only')!.textContent).toBe('ORD-TMZRB9-IR5JY');
  });

  it('the order number and the total appear once on the page', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    expect(screen.getAllByText('#1043')).toHaveLength(1);
    expect(screen.queryByText('Order total')).toBeNull();
    expect(screen.queryByText('إجمالي الطلب')).toBeNull();
  });
});

// Taste re-audit P2-5 (Y-05): the printer head repeated the page headline ("your order") and the
// paper's item count. It carries only the live payment status now; the paper holds the rest.
describe('printer head carries the status only (P2-5)', () => {
  it('no "your order" title and no item count above the paper', () => {
    render(<ReceiptPrinter order={order} paymentState="cod" store={store} />);
    const paper = screen.getByTestId('receipt-paper');
    const head = paper.closest('section')!.textContent!.split(paper.textContent!)[0];
    expect(head).not.toMatch(/طلبك(?! )|Your order/);
    expect(head).not.toMatch(/قطعة|قطعتان|قطع|items?\b/);
  });
});
