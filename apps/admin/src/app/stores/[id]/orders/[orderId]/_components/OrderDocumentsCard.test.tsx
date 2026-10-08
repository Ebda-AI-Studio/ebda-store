// @vitest-environment jsdom
/** The order page's Documents card: lists the order's fiscal documents with Open links. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/useCurrentStore', () => ({
  useCurrentStore: () => ({ store: { timezone: 'Africa/Cairo' } }),
}));
vi.mock('../../../../../../lib/api', () => api);

import { OrderDocumentsCard } from './OrderDocumentsCard';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = (over: Record<string, unknown>) => ({
  id: 'd1',
  orderId: 'o1',
  docType: 'tax_invoice',
  number: 'INV-000007',
  status: 'issued',
  issuedAt: '2026-10-01T10:00:00.000Z',
  cancelledAt: null,
  originalNumber: null,
  netAmount: 10000,
  vatAmount: 0,
  totalAmount: 10000,
  currency: 'EGP',
  orderNumber: 'ORD-1',
  ...over,
});

describe('OrderDocumentsCard', () => {
  it('lists number, type, status and total with a link to the viewer', async () => {
    api.apiGet.mockResolvedValue({
      data: {
        documents: [
          row({}),
          row({ id: 'd2', docType: 'credit_note', number: 'CN-000002', status: 'cancelled' }),
        ],
      },
    });
    render(<OrderDocumentsCard storeId="s1" orderId="o1" />);

    expect(await screen.findByText('INV-000007')).toBeTruthy();
    expect(screen.getByText('CN-000002')).toBeTruthy();
    expect(screen.getByText('statuses.cancelled')).toBeTruthy();
    expect(screen.getAllByText('100.00 EGP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('open').map(a => a.getAttribute('href'))).toEqual([
      '/stores/s1/invoices/d1',
      '/stores/s1/invoices/d2',
    ]);
    expect(api.apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/orders/o1/fiscal-documents');
  });

  it('says so when the order has no documents yet', async () => {
    api.apiGet.mockResolvedValue({ data: { documents: [] } });
    render(<OrderDocumentsCard storeId="s1" orderId="o1" />);
    expect(await screen.findByText('documentsCard.empty')).toBeTruthy();
  });

  it('shows an error rather than "no documents" when the request fails', async () => {
    api.apiGet.mockResolvedValue({ error: { code: 'X', message: 'boom', status: 500 } });
    render(<OrderDocumentsCard storeId="s1" orderId="o1" />);
    expect(await screen.findByText('documentsCard.loadFailed')).toBeTruthy();
    expect(screen.queryByText('documentsCard.empty')).toBeNull();
  });
});
