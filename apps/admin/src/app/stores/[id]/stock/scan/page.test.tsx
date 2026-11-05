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
const features = vi.hoisted(() => ({ enabled: true, loading: false }));
vi.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({
    isEnabled: (k: string) => (k === 'inventory.barcode' ? features.enabled : true),
    isLoading: features.loading,
    refresh: async () => {},
  }),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import BarcodeScanPage from './page';

afterEach(() => {
  features.enabled = true;
  features.loading = false;
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

describe('barcode scan page: plan gate (inventory.barcode)', () => {
  it('feature off: one plan panel, no mode buttons, no API call', () => {
    features.enabled = false;
    render(<BarcodeScanPage />);
    expect(screen.getByTestId('scan-feature-off').textContent).toBe('featureNotOnPlan');
    for (const k of ['modeReceive', 'modePick', 'modeCount']) {
      expect(screen.queryByText(k)).toBeNull();
    }
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('while the flags load: a skeleton, neither the panel nor the scanner', () => {
    features.loading = true;
    render(<BarcodeScanPage />);
    expect(screen.getByTestId('scan-features-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('scan-feature-off')).toBeNull();
    expect(screen.queryByText('modeReceive')).toBeNull();
  });

  it('feature on: the three modes render and the panel does not', () => {
    render(<BarcodeScanPage />);
    expect(screen.getAllByText('modeReceive').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('scan-feature-off')).toBeNull();
  });
});

describe('barcode scan page: pick mismatch warning', () => {
  const progress = {
    orderId: 'o-1',
    orderNumber: 'ORD-1',
    status: 'processing',
    fullyPicked: false,
    items: [{ id: 'i-1', productName: 'Abaya', quantity: 1, pickedQty: 0, pickedAt: null }],
  };

  async function scanOnLoadedOrder(code: string) {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('pick-progress')
        ? { data: progress, error: null }
        : {
            data: { orders: [{ id: 'o-1', orderNumber: 'ORD-1' }], meta: { total: 1 } },
            error: null,
          }
    );
    await loadOrderNumber('ORD-1');
    const input = await screen.findByPlaceholderText('barcodeInputPlaceholder');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    return code;
  }

  it('a wrong item shows the alert warning, not the generic not-found text', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: {
        code: 'NOT_IN_ORDER',
        message: 'Scarf is not in this order',
        status: 409,
        details: { productName: 'Scarf' },
      },
    });
    await scanOnLoadedOrder('NOT_IN_ORDER');
    const alert = await screen.findByTestId('pick-mismatch-warning');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('picking.notInOrder');
    expect(screen.queryByText('picking.itemNotFound')).toBeNull();
  });

  it('a surplus unit shows the already-picked warning', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: {
        code: 'ALREADY_PICKED',
        message: 'x',
        status: 409,
        details: { productName: 'Abaya' },
      },
    });
    await scanOnLoadedOrder('ALREADY_PICKED');
    expect((await screen.findByTestId('pick-mismatch-warning')).textContent).toBe(
      'picking.alreadyPicked'
    );
  });
});
