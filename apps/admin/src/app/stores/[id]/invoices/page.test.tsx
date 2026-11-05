// @vitest-environment jsdom
/** Invoices & credit notes list: rows render, type filter + cursor pagination hit the API. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
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
vi.mock('@/hooks/useCurrentStore', () => ({
  useCurrentStore: () => ({ store: { timezone: 'Africa/Cairo' } }),
}));
vi.mock('../../../../lib/api', () => api);

import InvoicesPage from './page';

const doc = (over: Record<string, unknown>) => ({
  id: 'd1',
  orderId: 'o1',
  docType: 'tax_invoice',
  number: 'INV-000001',
  status: 'issued',
  issuedAt: '2026-10-01T10:00:00.000Z',
  cancelledAt: null,
  originalNumber: null,
  netAmount: 10000,
  vatAmount: 1400,
  totalAmount: 11400,
  currency: 'EGP',
  orderNumber: 'ORD-1',
  ...over,
});

beforeEach(() => {
  // Render the desktop table (the order / VAT columns are hidden on the mobile card layout).
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  api.apiGet.mockResolvedValue({
    data: {
      documents: [
        doc({}),
        doc({
          id: 'd2',
          docType: 'credit_note',
          number: 'CN-000001',
          originalNumber: 'INV-000001',
          status: 'cancelled',
        }),
      ],
      nextCursor: null,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('InvoicesPage', () => {
  it('lists documents with number, type, status, order link, amounts and an Open link', async () => {
    render(<InvoicesPage />);
    expect((await screen.findAllByText('INV-000001')).length).toBeGreaterThan(0);
    expect(screen.getByText('CN-000001')).toBeTruthy();
    // the type label (the filter's <option> has the same text, hence 2)
    expect(screen.getAllByText('types.credit_note')).toHaveLength(2);
    expect(screen.getByText('statuses.cancelled')).toBeTruthy();
    expect(screen.getAllByText('114.00 EGP')).toHaveLength(2);

    const open = screen.getAllByText('open').map(a => a.getAttribute('href'));
    expect(open).toContain('/stores/store-1/invoices/d1');
    expect(screen.getAllByText('ORD-1')[0].getAttribute('href')).toBe('/stores/store-1/orders/o1');
    expect(api.apiGet).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/v1\/stores\/store-1\/fiscal-documents\?/)
    );
  });

  it('shows the explanatory empty state when nothing has been issued', async () => {
    api.apiGet.mockResolvedValue({ data: { documents: [], nextCursor: null } });
    render(<InvoicesPage />);
    expect(await screen.findByText('emptyTitle')).toBeTruthy();
    expect(screen.getByText('emptyDescription')).toBeTruthy();
  });

  it('filters by type and pages with the cursor', async () => {
    api.apiGet.mockResolvedValueOnce({ data: { documents: [doc({})], nextCursor: 'cur-1' } });
    render(<InvoicesPage />);
    fireEvent.click(await screen.findByText('loadMore'));
    await waitFor(() =>
      expect(api.apiGet).toHaveBeenLastCalledWith(expect.stringContaining('cursor=cur-1'))
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'credit_note' } });
    await waitFor(() =>
      expect(api.apiGet).toHaveBeenLastCalledWith(expect.stringContaining('docType=credit_note'))
    );
  });

  it('shows an error, not the empty state, when the list cannot be loaded', async () => {
    api.apiGet.mockResolvedValue({ error: { code: 'X', message: 'boom', status: 500 } });
    render(<InvoicesPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('emptyTitle')).toBeNull();
  });

  it('searches by document number: one debounced request with q, the type filter kept', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<InvoicesPage />);
      await screen.findAllByText('INV-000001');
      api.apiGet.mockClear();
      const box = screen.getByLabelText('searchPlaceholder');
      for (const v of ['I', 'IN', 'inv-0000']) fireEvent.change(box, { target: { value: v } });
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(api.apiGet).toHaveBeenCalledTimes(1));
      expect(String(api.apiGet.mock.calls[0][0])).toContain('q=inv-0000');
    } finally {
      vi.useRealTimers();
    }
  });
});
