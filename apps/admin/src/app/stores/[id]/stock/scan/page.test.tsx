// @vitest-environment jsdom
/**
 * Scan/pick screen: a 403 FEATURE_DISABLED (inventory.barcode not on the plan) shows the
 * "not on your plan" state, never "Order not found"; a genuinely missing order still says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/lib/api', () => ({ apiGet, apiPost }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import BarcodeScanPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadOrderNumber(value: string) {
  render(<BarcodeScanPage />);
  fireEvent.click(screen.getByText('modePick'));
  fireEvent.change(screen.getByPlaceholderText('orderNumberPlaceholder'), { target: { value } });
  fireEvent.click(screen.getByText('loadOrder'));
}

describe('barcode scan page: pick mode errors', () => {
  it('403 FEATURE_DISABLED shows the plan state, not "order not found"', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'FEATURE_DISABLED', message: 'Feature not available', status: 403 },
    });
    await loadOrderNumber('ORD-1');
    expect(await screen.findByText('featureNotOnPlan')).toBeTruthy();
    expect(screen.queryByText('orderNotFound')).toBeNull();
  });

  it('an order that really does not exist still says so', async () => {
    apiGet.mockResolvedValue({ data: { orders: [], meta: { total: 0 } }, error: null });
    await loadOrderNumber('ORD-404');
    await waitFor(() => expect(screen.getByText('orderNotFound')).toBeTruthy());
    expect(screen.queryByText('featureNotOnPlan')).toBeNull();
  });

  it('a plain 500 on the lookup keeps the generic not-found text', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'boom', status: 500 },
    });
    await loadOrderNumber('ORD-1');
    await waitFor(() => expect(screen.getByText('orderNotFound')).toBeTruthy());
  });
});
