// @vitest-environment jsdom
/**
 * A fully refunded order must read "Refunded" with nothing owed — it used to fall into the Unpaid arm and show
 * "Remain 160" (Amelia ORD-TOYND8-R19A2), inviting the merchant to chase refunded money.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OrderDetail } from './types';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${vars.amount}` : key),
    {
      has: () => true,
    }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../../components/payment-events/PaymentEventsTimeline', () => ({
  PaymentEventsTimeline: () => null,
}));

import { PaymentCard } from './PaymentCard';

afterEach(cleanup);

const order = (o: Partial<OrderDetail>): OrderDetail =>
  ({
    status: 'delivered',
    paymentStatus: 'paid',
    total: 16_000,
    currency: 'EGP',
    payments: [],
    ...o,
  }) as OrderDetail;

describe('PaymentCard states', () => {
  it('refunded: shows Refunded + the refunded amount, never Unpaid or Remain', () => {
    render(
      <PaymentCard
        order={order({
          status: 'refunded',
          paymentStatus: 'refunded',
          payments: [{ refundedAmount: 16_000 } as never],
        })}
      />
    );
    expect(screen.getByText('refunded')).toBeTruthy();
    expect(screen.getByText(/^refundedAmount:/)).toBeTruthy();
    expect(screen.queryByText('unpaid')).toBeNull();
    expect(screen.queryByText(/^remain:/)).toBeNull();
  });
  it('unpaid: still shows Unpaid + Remain', () => {
    render(<PaymentCard order={order({ status: 'pending', paymentStatus: 'unpaid' })} />);
    expect(screen.getByText('unpaid')).toBeTruthy();
    expect(screen.getByText(/^remain:/)).toBeTruthy();
  });
  it('paid: shows Paid only', () => {
    render(<PaymentCard order={order({})} />);
    expect(screen.getByText('paid')).toBeTruthy();
    expect(screen.queryByText(/^remain:/)).toBeNull();
  });
});
