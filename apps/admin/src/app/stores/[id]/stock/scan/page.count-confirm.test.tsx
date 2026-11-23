// @vitest-environment jsdom
/**
 * UX:ST-2 - closing and reconciling a stock count are irreversible and financial. The confirmation names the
 * line count, and (for reconcile) how many lines differ and the net units, through the shared confirm dialog,
 * never a native confirm().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost, askConfirm } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  askConfirm: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/lib/api', () => ({ apiGet, apiPost }));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => askConfirm }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => true, isLoading: false, refresh: async () => {} }),
}));
vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}|${JSON.stringify(vars)}` : key,
}));

import BarcodeScanPage from './page';

const line = (id: string, variance: number) => ({
  id,
  sessionId: 's1',
  productId: `p-${id}`,
  variantId: null,
  productName: `Item ${id}`,
  productNameAr: null,
  variantTitle: null,
  countedQty: 10 + variance,
  systemQty: 10,
  variance,
  scannedAt: '2026-11-04T10:00:00Z',
});

function session(status: 'open' | 'closed') {
  return {
    id: 's1',
    status,
    note: null,
    createdAt: '2026-11-04T10:00:00Z',
    closedAt: null,
    reconciledAt: null,
    adjustmentId: null,
    lines: [line('a', 2), line('b', -5), line('c', 0)],
  };
}

async function openSession(status: 'open' | 'closed') {
  apiGet.mockImplementation(async (url: string) =>
    url.includes('count-sessions?status=open')
      ? {
          data: [{ id: 's1', status, note: 'n', lineCount: 3, createdAt: '2026-11-04T10:00:00Z' }],
          error: null,
        }
      : { data: session(status), error: null }
  );
  render(<BarcodeScanPage />);
  fireEvent.click(screen.getByText('modeCount'));
  fireEvent.click(await screen.findByText('n'));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('stock count: close and reconcile confirmations', () => {
  it('closing names the number of counted lines and does nothing when declined', async () => {
    askConfirm.mockResolvedValue(false);
    await openSession('open');
    fireEvent.click(await screen.findByText('counting.closeSession'));
    await waitFor(() => expect(askConfirm).toHaveBeenCalledTimes(1));
    expect(askConfirm.mock.calls[0][0].object).toBe('counting.closeObject|{"count":3}');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('reconciling names the lines that differ and the net units, then posts only when confirmed', async () => {
    askConfirm.mockResolvedValue(true);
    apiPost.mockResolvedValue({
      data: { adjustmentId: null, linesReconciled: 2, zeroVarianceLines: 1 },
      error: null,
    });
    await openSession('closed');
    fireEvent.click(await screen.findByText('counting.reconcile'));
    await waitFor(() => expect(askConfirm).toHaveBeenCalledTimes(1));
    expect(askConfirm.mock.calls[0][0].object).toBe(
      'counting.reconcileObject|{"count":2,"units":"\u2066\u22123\u2069"}' // SIGN-1: the bidi-isolated true minus sign, not a hyphen
    );
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/v1/stores/store-1/inventory/count-sessions/s1/reconcile',
        {}
      )
    );
  });
});
