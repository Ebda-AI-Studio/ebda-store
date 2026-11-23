// @vitest-environment jsdom
/**
 * Issue 2443 — a rate save resolving after the merchant changed the currency filter refetched
 * through a `loadRates` captured from the old render (old filter) with no stale-response guard,
 * painting the previous filter's rows under the new one. The save now bumps a refreshKey so the one
 * load effect reads the CURRENT filter, and the load is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPost, calls, posts } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  posts: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', async importActual => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  apiGet,
  apiPost,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/mobile/DataTable', () => ({
  DataTable: ({
    rows,
    columns,
  }: {
    rows: Array<Record<string, unknown>>;
    columns: Array<{ cell: (r: Record<string, unknown>) => React.ReactNode }>;
  }) => (
    <div>
      {rows.map(r => (
        <div key={String(r.id)}>
          {columns.map((c, i) => (
            <span key={i}>{c.cell(r)}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import FxRatesPage from './page';

const rateCalls = () => calls.filter(c => c.url.includes('/fx-rates'));
const currencyOf = (url: string) => new URL(url, 'http://x').searchParams.get('currency') ?? 'ALL';

const respond = (d: Pending) =>
  d.resolve({
    data: [
      {
        id: `fx-${currencyOf(d.url)}`,
        currency: `CUR-${currencyOf(d.url)}`,
        rate: 1,
        rateDate: '2026-02-01',
        createdAt: '2026-02-01T00:00:00Z',
      },
    ],
  });

beforeEach(() => {
  calls.length = 0;
  posts.length = 0;
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/my-features'))
      return Promise.resolve({ data: { features: { 'accounting.multi_currency': true } } });
    return new Promise(resolve => calls.push({ url, resolve }));
  });
  apiPost.mockImplementation((url: string) => new Promise(resolve => posts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadAll() {
  render(<FxRatesPage />);
  await waitFor(() => expect(rateCalls()).toHaveLength(1));
  await act(async () => respond(rateCalls()[0]));
  await screen.findByText('CUR-ALL');
}

const filterSelect = () => screen.getAllByRole('combobox')[1];

describe('fx rates — refetch reads the CURRENT filter, latest wins (issue 2443)', () => {
  it('a save resolving after the currency filter changed repaints the CURRENT filter', async () => {
    await loadAll();
    fireEvent.change(screen.getByPlaceholderText('rateExample2'), { target: { value: '50' } });
    fireEvent.click(screen.getByText('saveRate')); // POST in flight, started under "all"
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.change(filterSelect(), { target: { value: 'USD' } });
    await waitFor(() => expect(rateCalls()).toHaveLength(2));

    await act(async () => posts[0].resolve({ error: null }));
    await waitFor(() => expect(rateCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of rateCalls().slice(1)) await act(async () => respond(c));

    expect(screen.getByText('CUR-USD')).toBeTruthy();
    expect(screen.queryByText('CUR-ALL')).toBeNull();
    expect(currencyOf(rateCalls()[rateCalls().length - 1].url)).toBe('USD');
  });

  it('an older filter response landing last never repaints (latest-wins guard)', async () => {
    await loadAll();
    fireEvent.change(filterSelect(), { target: { value: 'USD' } });
    await waitFor(() => expect(rateCalls()).toHaveLength(2));
    fireEvent.change(filterSelect(), { target: { value: 'EUR' } });
    await waitFor(() => expect(rateCalls()).toHaveLength(3));

    await act(async () => respond(rateCalls()[2])); // EUR (newest) first
    await act(async () => respond(rateCalls()[1])); // USD lands LAST

    expect(screen.getByText('CUR-EUR')).toBeTruthy();
    expect(screen.queryByText('CUR-USD')).toBeNull();
  });
});

describe('fx rates — API field errors render under the field', () => {
  it('shows the rate error under the rate input', async () => {
    await loadAll();
    fireEvent.change(screen.getByPlaceholderText('rateExample2'), { target: { value: '50' } });
    fireEvent.click(screen.getByText('saveRate'));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () =>
      posts[0].resolve({
        error: { message: 'bad', status: 400, details: { rate: ['Rate must be positive'] } },
      })
    );
    const msg = await screen.findAllByText('Rate must be positive');
    expect(msg.length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('rateExample2').closest('label')?.textContent).toContain(
      'Rate must be positive'
    );
  });
});
