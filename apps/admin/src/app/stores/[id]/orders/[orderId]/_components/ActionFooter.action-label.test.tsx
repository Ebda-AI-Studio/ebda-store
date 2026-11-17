// @vitest-environment jsdom
/**
 * O4: the primary button named the TARGET status ("مُسترد ✓"), so a delivered order read as already
 * refunded. It now carries a verb label and no check mark. Real en/ar messages are resolved here
 * (the sibling test echoes keys, which cannot tell a verb from a state).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ar from '../../../../../../i18n/messages/ar.json';
import en from '../../../../../../i18n/messages/en.json';
import { orderActionKey } from '../../_components/order-action';
import type { OrderDetail } from './types';

vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string) => {
    let o: unknown = ar as unknown;
    for (const part of `${ns}.${k}`.split('.')) o = (o as Record<string, unknown>)?.[part];
    return typeof o === 'string' ? o : k;
  },
}));
for (const m of [
  'PaymentLinkButton',
  'RefreshPaymentButton',
  'RefundButton',
  'RefreshRefundStatusButton',
  'InstapayRefundButton',
]) {
  vi.doMock(`./${m}`, () => ({ [m]: () => null }));
}

import { ActionFooter } from './ActionFooter';

afterEach(cleanup);

const order = {
  id: 'o1',
  storeId: 's1',
  orderNumber: 'A-1',
  status: 'delivered',
  paymentStatus: 'paid',
  total: 1000,
  currency: 'EGP',
  items: [],
  payments: [],
  subtotal: 0,
  tax: 0,
  shipping: 0,
  discount: 0,
} as unknown as OrderDetail;

describe('order status action labels', () => {
  it('a delivered paid order offers "record as refunded", not the bare status, and no check icon', () => {
    render(
      <ActionFooter
        order={order}
        storeId="s1"
        isUpdating={false}
        canRefund
        onStatusChange={() => {}}
        onMarkPaid={() => {}}
        onPrintInvoice={() => {}}
      />
    );
    const btn = screen.getByText('سجّل إن الطلب اترد').closest('button')!;
    expect(btn.textContent).toBe('سجّل إن الطلب اترد');
    expect(btn.querySelector('svg')).toBeNull();
    expect(screen.queryByText('مُسترد')).toBeNull();
  });

  it('every status has a verb label in both languages that differs from its status name', () => {
    for (const msgs of [en, ar] as Array<typeof en>) {
      const o = msgs.orders as unknown as {
        action: Record<string, string>;
        status: Record<string, string>;
      };
      for (const s of Object.keys(o.status)) {
        expect(orderActionKey(s)).toBe(true);
        expect(o.action[s], s).toBeTruthy();
        expect(o.action[s], s).not.toBe(o.status[s]);
      }
    }
  });
});
