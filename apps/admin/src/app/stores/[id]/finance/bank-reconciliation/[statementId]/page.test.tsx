// @vitest-environment jsdom
/**
 * Issue 2443 — an Ignore started under the "all" filter and resolved after the merchant clicked the
 * "unmatched" pill refetched through a `fetchTxs` captured from the "all" render, claimed the newest
 * request slot and repainted "all" rows under the "unmatched" pill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiGetPage, apiPatch, calls, patches } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiGetPage: vi.fn(),
  apiPatch: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  patches: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGet, apiGetPage, apiPost: vi.fn(), apiPatch }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1', statementId: 'stmt-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/lib/format', () => ({ filsToKwd: (n: number) => String(n) }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/PageControls', () => ({ PageControls: () => null }));

import StatementDetailPage from './page';

const filterOf = (url: string) => new URL(url, 'http://x').searchParams.get('matchStatus') ?? 'all';

function respond(d: Pending) {
  const filter = filterOf(d.url);
  d.resolve({
    data: [
      {
        id: 'tx1',
        date: '2026-02-01T00:00:00Z',
        description: `TX-FILTER-${filter}`,
        amountFils: 1000,
        direction: 'debit',
        externalRef: null,
        matchStatus: 'unmatched',
        confidence: 0,
        matchedJournalEntryId: null,
        matchedJournalEntry: null,
      },
    ],
    meta: { page: 1, perPage: 200, total: 1, totalPages: 1 },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  patches.length = 0;
  apiGet.mockResolvedValue({ data: null, error: null });
  apiGetPage.mockImplementation(
    (url: string) => new Promise(resolve => calls.push({ url, resolve }))
  );
  apiPatch.mockImplementation(
    (url: string) => new Promise(resolve => patches.push({ url, resolve }))
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('statement transactions — post-action refetch reads the CURRENT filter (issue 2443)', () => {
  it('an Ignore resolving after a filter change repaints the CURRENT filter, not the stale one', async () => {
    render(<StatementDetailPage />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => respond(calls[0]));
    await screen.findByText('TX-FILTER-all');

    fireEvent.click(screen.getByText('ignore')); // PATCH in flight, started under "all"
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'statusLabels.unmatched' }));
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => patches[0].resolve({ error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('TX-FILTER-unmatched')).toBeTruthy();
    expect(screen.queryByText('TX-FILTER-all')).toBeNull();
    expect(filterOf(calls[calls.length - 1].url)).toBe('unmatched');
  });
});
