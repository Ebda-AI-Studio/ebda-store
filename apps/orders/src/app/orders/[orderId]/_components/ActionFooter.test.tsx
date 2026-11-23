// @vitest-environment jsdom
/**
 * #1936 — the orders PWA kept its own stale transition map (no `cancelled`
 * key), and its footer treated `cancelled` as final, so a paid, cancelled
 * order could not be marked refunded from orders.ebda.app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OrderDetail } from '@/lib/orders';

vi.mock('@/contexts/LanguageContext', () => {
  const echo = new Proxy({}, { get: (_t, key) => String(key) });
  return {
    useLanguage: () => ({
      t: { detail: { actions: echo }, status: echo, action: echo },
      locale: 'en',
    }),
  };
});
vi.mock('./PaymentLinkButton', () => ({ PaymentLinkButton: () => null }));
vi.mock('./RefreshPaymentButton', () => ({ RefreshPaymentButton: () => null }));
vi.mock('./RefundButton', () => ({
  RefundButton: () => <button data-testid="refund-button">refund</button>,
}));
vi.mock('./RefreshRefundStatusButton', () => ({ RefreshRefundStatusButton: () => null }));
vi.mock('./InvoiceButton', () => ({ InvoiceButton: () => null }));

import { ActionFooter } from './ActionFooter';

afterEach(() => cleanup());

function order(status: string, paymentStatus: string): OrderDetail {
  return {
    id: 'o1',
    storeId: 's1',
    orderNumber: 'ORD-1',
    total: 5000,
    currency: 'EGP',
    status,
    paymentStatus,
    createdAt: '2026-09-01T00:00:00.000Z',
    payments: [],
    items: [],
  } as unknown as OrderDetail;
}

function renderFooter(o: OrderDetail, onStatusChange = vi.fn(), canRefund = true) {
  render(
    <ActionFooter
      order={o}
      storeId="s1"
      isUpdating={false}
      canRefund={canRefund}
      onStatusChange={onStatusChange}
      onMarkPaid={() => {}}
      onRefetch={() => {}}
    />
  );
  return onStatusChange;
}

describe('orders PWA ActionFooter — status action (#1936)', () => {
  it('offers Refunded on a PAID cancelled order', () => {
    const onStatusChange = renderFooter(order('cancelled', 'paid'));
    fireEvent.click(screen.getByText('refunded'));
    expect(onStatusChange).toHaveBeenCalledWith('refunded');
  });

  it('offers nothing on an UNPAID cancelled order', () => {
    renderFooter(order('cancelled', 'unpaid'));
    expect(screen.queryByText('refunded')).toBeNull();
  });

  it('offers Refunded on a PAID delivered order (#2144)', () => {
    const onStatusChange = renderFooter(order('delivered', 'paid'));
    fireEvent.click(screen.getByText('refunded'));
    expect(onStatusChange).toHaveBeenCalledWith('refunded');
  });

  it('offers nothing on a refunded order', () => {
    renderFooter(order('refunded', 'paid'));
    expect(screen.queryByText('refunded')).toBeNull();
  });

  it('keeps the usual next step for an active order', () => {
    const onStatusChange = renderFooter(order('shipped', 'paid'));
    fireEvent.click(screen.getByText('delivered'));
    expect(onStatusChange).toHaveBeenCalledWith('delivered');
  });
});

// Recording or issuing a refund needs the API's orders:refund permission; staff lack it.
describe('orders PWA ActionFooter - staff (canRefund=false)', () => {
  const online = (o: OrderDetail) =>
    ({
      ...o,
      payments: [{ provider: 'paymob', status: 'completed', transactionId: 'txn_1' }],
    }) as unknown as OrderDetail;

  it('hides Refund-via-provider on a paid online order, but a refund-capable user sees it', () => {
    renderFooter(online(order('confirmed', 'paid')), vi.fn(), false);
    expect(screen.queryByTestId('refund-button')).toBeNull();
    cleanup();
    renderFooter(online(order('confirmed', 'paid')), vi.fn(), true);
    expect(screen.getByTestId('refund-button')).toBeTruthy();
  });

  it.each(['delivered', 'confirmed', 'cancelled'])(
    'never offers the Refunded status on a paid %s order',
    status => {
      renderFooter(order(status, 'paid'), vi.fn(), false);
      expect(screen.queryByText('refunded')).toBeNull();
    }
  );

  it('keeps the usual next step', () => {
    const onStatusChange = renderFooter(order('shipped', 'paid'), vi.fn(), false);
    fireEvent.click(screen.getByText('delivered'));
    expect(onStatusChange).toHaveBeenCalledWith('delivered');
  });
});

// SP6a — InstaPay awaiting confirmation: the one-thumb "payment received" control.
vi.mock('@/components/ConfirmInstapayButton', () => ({
  ConfirmInstapayButton: ({ amountMinor }: { amountMinor: number }) => (
    <button data-testid="confirm-instapay" data-amount={amountMinor}>
      confirm
    </button>
  ),
}));

describe('orders PWA ActionFooter - InstaPay', () => {
  const awaiting = () =>
    ({
      ...order('awaiting_payment_confirmation', 'unpaid'),
      payments: [{ provider: 'instapay', status: 'pending', transactionId: 'instapay_k1' }],
    }) as unknown as OrderDetail;

  it('shows the confirm control with the exact amount, and never offers to ship', () => {
    renderFooter(awaiting());
    expect(screen.getByTestId('confirm-instapay').getAttribute('data-amount')).toBe('5000');
    expect(screen.queryByText('processing')).toBeNull();
    expect(screen.queryByText('shipped')).toBeNull();
  });

  it('shows no confirm control on an ordinary confirmed order', () => {
    renderFooter(order('confirmed', 'paid'));
    expect(screen.queryByTestId('confirm-instapay')).toBeNull();
  });
});
