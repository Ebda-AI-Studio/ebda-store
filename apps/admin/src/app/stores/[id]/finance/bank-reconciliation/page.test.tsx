// @vitest-environment jsdom
/**
 * Issue 2443 — a Delete started on page 1 and resolved after the merchant paged to page 2 refetched
 * through a `fetchStatements` captured from the page-1 render, claimed the newest request slot and
 * repainted page-1 rows under a page-2 pager. The refetch must route through the fetch effect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGetPage, apiDelete, calls, deletes } = vi.hoisted(() => ({
  apiGetPage: vi.fn(),
  apiDelete: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  deletes: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGetPage, apiDelete }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/PageControls', () => ({
  PageControls: ({ onPageChange }: { onPageChange: (p: number) => void }) => (
    <button onClick={() => onPageChange(2)}>go-2</button>
  ),
}));

import BankReconciliationPage from './page';

const pageOf = (url: string) => Number(new URL(url, 'http://x').searchParams.get('page'));

function respond(d: Pending) {
  const page = pageOf(d.url);
  d.resolve({
    data: [
      {
        id: `s${page}`,
        fileName: `STATEMENT-PAGE-${page}`,
        importedAt: '2026-02-01T00:00:00Z',
        periodStart: null,
        periodEnd: null,
        status: 'pending',
        glAccount: { code: '1000', nameEn: 'Bank', nameAr: null },
        _count: { transactions: 1 },
      },
    ],
    meta: { page, perPage: 50, total: 120, totalPages: 3 },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  deletes.length = 0;
  apiGetPage.mockImplementation(
    (url: string) => new Promise(resolve => calls.push({ url, resolve }))
  );
  apiDelete.mockImplementation(
    (url: string) => new Promise(resolve => deletes.push({ url, resolve }))
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('bank statements — post-delete refetch reads the CURRENT page (issue 2443)', () => {
  it('a delete resolving after the pager moved repaints the CURRENT page, not the stale one', async () => {
    render(<BankReconciliationPage />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => respond(calls[0]));
    await screen.findByText('STATEMENT-PAGE-1');

    fireEvent.click(screen.getByLabelText('rowMenu')); // row actions live in the "..." menu
    fireEvent.click(screen.getByText('delete')); // DELETE in flight, started on page 1
    await waitFor(() => expect(deletes).toHaveLength(1));
    fireEvent.click(screen.getByText('go-2')); // merchant pages on while it is in flight
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => deletes[0].resolve({ error: null }));
    // Let every request land in the order it was issued (the stale one last under the old code).
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls) await act(async () => respond(c));

    expect(screen.getByText('STATEMENT-PAGE-2')).toBeTruthy();
    expect(screen.queryByText('STATEMENT-PAGE-1')).toBeNull();
    expect(pageOf(calls[calls.length - 1].url)).toBe(2);
  });
});
