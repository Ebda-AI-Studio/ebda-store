// @vitest-environment jsdom
/**
 * Issue 2275 — cancelling a backorder line sends NO money (Ruling AP-5b(2)).
 * The modal must not promise a refund, and must state what the merchant still
 * owes the customer once the line is cancelled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/api', () => api);

import BackordersPage from './page';

const LINE = {
  id: 'bo-1',
  qty: 2,
  qtyFulfilled: 0,
  createdAt: '2026-09-20T00:00:00.000Z',
  product: { id: 'p1', name: 'Mug', sku: 'MUG' },
  orderItem: { id: 'oi1', order: { id: 'o1', orderNumber: '1001', shippingAddress: null } },
};

beforeEach(() => {
  api.apiGet.mockResolvedValue({ data: [LINE], error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function cancelLine() {
  render(<BackordersPage />);
  fireEvent.click((await screen.findAllByText('cancel'))[0]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'supplier out' } });
  fireEvent.click(screen.getByText('cancelModal.confirm'));
}

describe('backorder cancel modal (issue 2275)', () => {
  it('says up front that no money is sent', async () => {
    render(<BackordersPage />);
    fireEvent.click((await screen.findAllByText('cancel'))[0]);
    expect(screen.getByText('cancelModal.body')).toBeTruthy();
  });

  it('after cancelling a paid line, states what is still owed to the customer', async () => {
    api.apiPost.mockResolvedValue({ data: { id: 'bo-1', owedToCustomer: 2000 }, error: null });
    await cancelLine();
    await waitFor(() => expect(screen.getByText(/cancelModal\.owedNotice/)).toBeTruthy());
    expect(screen.getByText(/20(?!\d)/)).toBeTruthy();
  });

  it('an unpaid line owes nothing: the modal just closes', async () => {
    api.apiPost.mockResolvedValue({ data: { id: 'bo-1', owedToCustomer: 0 }, error: null });
    await cancelLine();
    await waitFor(() => expect(screen.queryByText('cancelModal.body')).toBeNull());
    expect(screen.queryByText(/cancelModal\.owedNotice/)).toBeNull();
  });
});
