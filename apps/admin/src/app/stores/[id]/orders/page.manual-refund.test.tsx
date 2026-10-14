// @vitest-environment jsdom
/**
 * #762 — picking "Refunded" in the order-list status dropdown records a refund
 * (stock/coupon/loyalty reversal + a "Refund issued" message to the customer)
 * but moves NO money. It must ask first; every other status still applies on
 * pick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/stores/store-1/orders',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/DateRangePicker', () => ({ DateRangePicker: () => null }));
vi.mock('../../../../lib/api', () => api);
const auth = vi.hoisted(() => ({ role: 'store_admin' as string }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

import { ToastProvider } from '@ebda/ui';
import OrdersPage from './page';

const ORDER = {
  id: 'order-1',
  orderNumber: 'ORD-1',
  status: 'confirmed',
  paymentStatus: 'paid',
  total: 12000,
  createdAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  // The page remembers the page-size choice in localStorage; give it a
  // working one regardless of the runtime's own (Node's experimental
  // global can shadow jsdom's).
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  api.apiGet.mockResolvedValue({
    // No page/limit in the meta: echoing them back would change the
    // pagination state and re-run the fetch, unmounting the row mid-test.
    data: { orders: [ORDER], meta: { total: 1, totalPages: 1 } },
  });
  api.apiPut.mockResolvedValue({ data: {} });
  auth.role = 'store_admin';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function pick(status: string) {
  render(
    <ToastProvider>
      <OrdersPage />
    </ToastProvider>
  );
  const selects = (await screen.findAllByLabelText(
    'actions.updateStatusLabel'
  )) as HTMLSelectElement[];
  fireEvent.change(selects[0], { target: { value: status } });
}

describe('orders list — manual "Refunded" needs confirmation', () => {
  it('does not PUT refunded on pick; asks first, and PUTs only after confirm, recording the refund', async () => {
    await pick('refunded');

    expect(api.apiPut).not.toHaveBeenCalled();
    // The dialog says the money must already have been returned, and asks how.
    expect(await screen.findByText('manualRefundDescription')).toBeTruthy();
    expect(screen.getByLabelText('refundMethodLabel')).toBeTruthy();

    fireEvent.click(screen.getByText('confirm'));
    await waitFor(() =>
      expect(api.apiPut).toHaveBeenCalledWith('/api/v1/stores/store-1/orders/order-1/status', {
        status: 'refunded',
        refundRecorded: true,
        refundMethod: 'cash',
      })
    );
  });

  it('sends the chosen method and trimmed reference', async () => {
    await pick('refunded');
    fireEvent.change(await screen.findByLabelText('refundMethodLabel'), {
      target: { value: 'instapay' },
    });
    fireEvent.change(screen.getByLabelText('refundReferenceLabel'), {
      target: { value: '  TXN-42  ' },
    });
    fireEvent.click(screen.getByText('confirm'));
    await waitFor(() =>
      expect(api.apiPut).toHaveBeenCalledWith('/api/v1/stores/store-1/orders/order-1/status', {
        status: 'refunded',
        refundRecorded: true,
        refundMethod: 'instapay',
        refundReference: 'TXN-42',
      })
    );
  });

  it('shows the API message inside the dialog when the server refuses (409/403)', async () => {
    api.apiPut.mockResolvedValue({
      error: { code: 'REFUND_NOT_RECORDED', message: 'Record the refund first', status: 409 },
    });
    await pick('refunded');
    fireEvent.click(await screen.findByText('confirm'));
    expect(await screen.findByText('Record the refund first')).toBeTruthy();
    // still open so the merchant can retry
    expect(screen.getByText('manualRefundDescription')).toBeTruthy();
  });

  it('cancelling the dialog changes nothing', async () => {
    await pick('refunded');
    fireEvent.click(await screen.findByText('cancel'));
    expect(api.apiPut).not.toHaveBeenCalled();
  });

  it('any other status still applies immediately (control)', async () => {
    await pick('processing');
    await waitFor(() =>
      expect(api.apiPut).toHaveBeenCalledWith('/api/v1/stores/store-1/orders/order-1/status', {
        status: 'processing',
      })
    );
  });

  it('staff are not offered Refunded in the status dropdown', async () => {
    auth.role = 'staff';
    render(
      <ToastProvider>
        <OrdersPage />
      </ToastProvider>
    );
    const select = (await screen.findAllByLabelText(
      'actions.updateStatusLabel'
    )) as HTMLSelectElement[];
    const values = Array.from(select[0].options).map(o => o.value);
    expect(values).not.toContain('refunded');
    expect(values).toContain('processing');
  });
});
