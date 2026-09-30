// @vitest-environment jsdom
/**
 * B4a — second admin render component. `ActionFooter` decides which action
 * buttons a merchant sees on the order-detail page, and two of its branches
 * guard a money-integrity path that has no other test coverage:
 *
 *   - `showManualMarkPaid` must be false whenever the order has a real
 *     payment-provider row (MyFatoorah/Tap/Hesabe/UPayments) — letting a
 *     merchant manually flip a provider-tracked order to "paid" would create
 *     a false paid record for money that was never actually captured.
 *   - `showRefundViaProvider` must require BOTH `paymentStatus === 'paid'`
 *     AND a completed non-COD payment with a transactionId, AND
 *     `order.status !== 'refunded'` — showing it for an unpaid/COD/already-
 *     refunded order risks a merchant triggering a real refund call for
 *     money that either doesn't exist or was already returned.
 *
 * These are exactly the "real user-facing logic" this task asks for — a
 * defect here is a financial-safety regression, not a cosmetic one — which
 * is why this is the second component (alongside OrdersTable) chosen for
 * B4a's render-test layer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OrderDetail, OrderPaymentDetail } from './types';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return {
    useTranslations: () => t,
    useLocale: () => 'en',
  };
});

// Stub the four action buttons so this test exercises ONLY ActionFooter's
// own show/hide decisions, not each button's internal API-calling logic
// (that belongs to each button's own tests, if/when they're written).
vi.mock('./PaymentLinkButton', () => ({
  PaymentLinkButton: () => <button data-testid="payment-link-button">payment-link</button>,
}));
vi.mock('./RefreshPaymentButton', () => ({
  RefreshPaymentButton: () => <button data-testid="refresh-payment-button">refresh-payment</button>,
}));
vi.mock('./RefundButton', () => ({
  RefundButton: ({ total }: { total: number }) => (
    <button data-testid="refund-button" data-total={total}>
      refund
    </button>
  ),
}));
vi.mock('./RefreshRefundStatusButton', () => ({
  RefreshRefundStatusButton: () => (
    <button data-testid="refresh-refund-status-button">refresh-refund-status</button>
  ),
}));

import { ActionFooter } from './ActionFooter';

afterEach(() => {
  cleanup();
});

function payment(overrides: Partial<OrderPaymentDetail>): OrderPaymentDetail {
  return {
    id: 'pay-1',
    provider: 'cod',
    status: 'pending',
    amount: 12000,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function baseOrder(
  overrides: Partial<OrderDetail> & Pick<OrderDetail, 'status' | 'paymentStatus'>
): OrderDetail {
  return {
    id: 'order-1',
    storeId: 'store-1',
    orderNumber: 'ORD-1001',
    subtotal: 12000,
    tax: 0,
    shipping: 0,
    discount: 0,
    total: 12000,
    currency: 'KWD',
    notes: null,
    customerNotes: null,
    shippingAddress: null,
    billingAddress: null,
    shippedAt: null,
    deliveredAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    items: [],
    payments: [],
    ...overrides,
  };
}

function renderFooter(order: OrderDetail, onStatusChange: (s: string) => void = () => {}) {
  return render(
    <ActionFooter
      order={order}
      storeId="store-1"
      isUpdating={false}
      onStatusChange={onStatusChange}
      onMarkPaid={() => {}}
      onPrintInvoice={() => {}}
    />
  );
}

describe('ActionFooter — money-safety button visibility (renders the real DOM via jsdom)', () => {
  it('shows manual "Mark as Paid" + Cancel for an unpaid COD order, never a refund control', () => {
    const order = baseOrder({
      status: 'confirmed',
      paymentStatus: 'unpaid',
      payments: [payment({ provider: 'cod', status: 'pending' })],
    });
    renderFooter(order);

    // COD has no provider row to authoritatively confirm payment, so the
    // MANUAL toggle is the one that must appear here (this is the branch
    // `showManualMarkPaid` exists for).
    expect(screen.getByText('markPaid')).toBeTruthy();
    expect(screen.getByText('cancel')).toBeTruthy();
    expect(screen.queryByTestId('refund-button')).toBeNull();
  });

  it('shows the Refund control for a paid order with a completed online payment, and hides manual Mark-as-Paid', () => {
    const order = baseOrder({
      status: 'confirmed',
      paymentStatus: 'paid',
      payments: [
        payment({
          provider: 'myfatoorah',
          status: 'completed',
          transactionId: 'txn_123',
        }),
      ],
    });
    renderFooter(order);

    expect(screen.getByTestId('refund-button')).toBeTruthy();
    expect(screen.queryByText('markPaid')).toBeNull();
  });

  it('never shows the Refund control for an order already marked refunded, even with a completed online payment', () => {
    const order = baseOrder({
      status: 'refunded',
      paymentStatus: 'paid',
      payments: [
        payment({
          provider: 'myfatoorah',
          status: 'completed',
          transactionId: 'txn_123',
        }),
      ],
    });
    renderFooter(order);

    expect(screen.queryByTestId('refund-button')).toBeNull();
    // A final status also has no "next status" button and no Cancel button.
    expect(screen.queryByText('cancel')).toBeNull();
  });

  it('never shows the manual Mark-as-Paid toggle when a real payment-provider row exists, even while unpaid', () => {
    // Money-integrity guard: a provider-tracked order (has a paymentUrl/
    // transactionId) must only flip to paid via the provider webhook.
    const order = baseOrder({
      status: 'pending',
      paymentStatus: 'unpaid',
      payments: [
        payment({ provider: 'myfatoorah', status: 'pending', paymentUrl: 'https://pay.example/x' }),
      ],
    });
    renderFooter(order);

    expect(screen.queryByText('markPaid')).toBeNull();
    // The provider-tracking affordances should appear instead.
    expect(screen.getByTestId('payment-link-button')).toBeTruthy();
    expect(screen.getByTestId('refresh-payment-button')).toBeTruthy();
  });
});

// #1947 — the detail page read the raw transition map and treated `cancelled`
// as final, so a paid, cancelled order (refundable since PR #770) rendered no
// status action here at all.
describe('ActionFooter — status action for a cancelled order (#1947)', () => {
  it('offers Refunded as the primary action on a PAID cancelled order', () => {
    const onStatusChange = vi.fn();
    renderFooter(baseOrder({ status: 'cancelled', paymentStatus: 'paid' }), onStatusChange);

    // useT is mocked to echo the key, so the status label renders as 'refunded'.
    fireEvent.click(screen.getByText('refunded'));
    expect(onStatusChange).toHaveBeenCalledWith('refunded');
    expect(screen.queryByText('cancel')).toBeNull();
  });

  it('offers no status action on an UNPAID cancelled order (nothing to refund)', () => {
    renderFooter(baseOrder({ status: 'cancelled', paymentStatus: 'unpaid' }));
    expect(screen.queryByText('refunded')).toBeNull();
  });

  it('does not offer Refunded on an unpaid pending order, and still offers its next step', () => {
    renderFooter(baseOrder({ status: 'pending', paymentStatus: 'unpaid' }));
    expect(screen.getByText('confirmed')).toBeTruthy();
    expect(screen.queryByText('refunded')).toBeNull();
  });

  // #2144 — `delivered` was hand-listed as final, hiding the `refunded` the
  // shared map offers for it: a delivered cash order had no refund action here.
  it('offers Refunded on a PAID delivered order', () => {
    const onStatusChange = vi.fn();
    renderFooter(baseOrder({ status: 'delivered', paymentStatus: 'paid' }), onStatusChange);
    fireEvent.click(screen.getByText('refunded'));
    expect(onStatusChange).toHaveBeenCalledWith('refunded');
  });

  it('offers no status action on a refunded order', () => {
    renderFooter(baseOrder({ status: 'refunded', paymentStatus: 'paid' }));
    expect(screen.queryByText('refunded')).toBeNull();
  });
});

// #2069 — the refund confirm quoted the order value even after a partial
// refund; the provider is asked for the payment's remainder.
describe('ActionFooter — refund-via-provider amount (#2069)', () => {
  it('passes the payment remainder, not the order total, after a partial refund', () => {
    renderFooter(
      baseOrder({
        status: 'delivered',
        paymentStatus: 'paid',
        total: 5000,
        payments: [
          payment({
            provider: 'tap',
            status: 'partially_refunded',
            transactionId: 'tx',
            amount: 5000,
            refundedAmount: 2000,
          }),
        ],
      })
    );
    expect(screen.getByTestId('refund-button').getAttribute('data-total')).toBe('3000');
  });
});
