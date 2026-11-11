// @vitest-environment jsdom
/**
 * SP7 COD reconciliation page (every data has a UI): open the page -> the totals, the
 * per-shipment match and the unmatched lines render, and a statement can be imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    {
      has: () => true,
    }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ gate: null }),
}));
vi.mock('../../../../lib/api', () => api);
vi.mock('../shipping/_components/ShippingTabs', () => ({ ShippingTabs: () => null }));

import { ToastProvider } from '@ebda/ui';
import CodReconciliationPage from './page';

const REPORT = {
  summary: {
    shipments: 2,
    owed: 72_345,
    gross: 62_346,
    fees: 623,
    net: 61_723,
    outstanding: 9_999,
    over: 0,
    unmatchedGross: 777,
    unmatchedLines: 1,
    flaggedShipments: 1,
  },
  total: 2,
  rows: [
    {
      shipmentId: 'a',
      orderNumber: 'ORD-1',
      carrier: 'bosta',
      carrierName: null,
      trackingNumber: 'BST1',
      shipmentStatus: 'delivered',
      lines: [
        {
          id: 'l1',
          grossAmount: 12_345,
          feeAmount: 123,
          netAmount: 12_222,
          remittedAt: '2026-10-06T00:00:00Z',
          batchId: null,
        },
      ],
      result: {
        status: 'settled',
        owed: 12_345,
        gross: 12_345,
        fees: 123,
        net: 12_222,
        outstanding: 0,
        over: 0,
        flagged: false,
      },
    },
    {
      shipmentId: 'b',
      orderNumber: 'ORD-2',
      carrier: 'aramex',
      carrierName: null,
      trackingNumber: 'ARX1',
      shipmentStatus: 'delivered',
      lines: [
        {
          id: 'l2',
          grossAmount: 30_000,
          feeAmount: 300,
          netAmount: 29_700,
          remittedAt: '2026-10-06T00:00:00Z',
          batchId: null,
        },
        {
          id: 'l3',
          grossAmount: 20_001,
          feeAmount: 200,
          netAmount: 19_801,
          remittedAt: '2026-10-07T00:00:00Z',
          batchId: null,
        },
      ],
      result: {
        status: 'partial',
        owed: 60_000,
        gross: 50_001,
        fees: 500,
        net: 49_501,
        outstanding: 9_999,
        over: 0,
        flagged: true,
      },
    },
  ],
  unmatched: [
    {
      id: 'u1',
      carrier: 'bosta',
      trackingNumber: 'NOT-OURS',
      grossAmount: 777,
      feeAmount: 7,
      netAmount: 770,
      remittedAt: '2026-10-07T00:00:00Z',
    },
  ],
};

beforeEach(() => {
  api.apiGet.mockReset().mockResolvedValue({ data: REPORT });
  api.apiPost.mockReset();
});
afterEach(cleanup);

const mount = () =>
  render(
    <ToastProvider>
      <CodReconciliationPage />
    </ToastProvider>
  );

describe('COD reconciliation page', () => {
  it('renders the totals to the piastre, each shipment with its match, and the unmatched lines', async () => {
    mount();
    // 72345 piastres = 723.45 EGP; the open amount of the partial shipment is 99.99
    expect(await screen.findByText('723.45 ج.م')).toBeTruthy();
    expect(screen.getAllByText('99.99 ج.م').length).toBeGreaterThan(0);
    expect(screen.getByText('ORD-1')).toBeTruthy();
    expect(screen.getByText('ORD-2')).toBeTruthy();
    expect(screen.getByText('BST1')).toBeTruthy();
    expect(screen.getByText('lines:{"count":2}')).toBeTruthy();
    expect(screen.getAllByText('unmatchedTitle').length).toBeGreaterThan(0);
    expect(screen.getByText('NOT-OURS')).toBeTruthy();
  });

  it('imports a pasted statement for the chosen carrier and reloads', async () => {
    api.apiPost.mockResolvedValue({
      data: {
        inserted: 2,
        duplicates: 0,
        unmatched: 1,
        rejected: [{ line: 4, reason: 'net is not collected minus fee' }],
      },
      error: null,
    });
    mount();
    fireEvent.change(await screen.findByLabelText('paste'), {
      target: { value: 'awb,collected\nBST1,123.45' },
    });
    fireEvent.click(screen.getByText('import'));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/store-1/cod-reconciliation/import', {
        carrier: 'bosta',
        csv: 'awb,collected\nBST1,123.45',
      })
    );
    expect(await screen.findByText(/rejectedLine/)).toBeTruthy();
    expect(api.apiGet.mock.calls.length).toBeGreaterThan(1); // reloaded after the import
  });

  it('filters by status through the API', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('filterStatus'), {
      target: { value: 'flagged' },
    });
    await waitFor(() =>
      expect(api.apiGet).toHaveBeenLastCalledWith(expect.stringContaining('status=flagged'))
    );
  });
});
