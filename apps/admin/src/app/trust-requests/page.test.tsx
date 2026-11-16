// @vitest-environment jsdom
/**
 * Super-admin trust requests page: an API failure is an error (not "no requests"), filters go to the API, a request
 * opens in full, and RESOLVE / REJECT post the decision and reload the list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../components/RequireSuperAdmin', () => ({
  RequireSuperAdmin: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../i18n/useT', () => ({ useT: () => (key: string) => key }));

import TrustRequestsPage from './page';

const ID = '00000000-0000-4000-8000-000000000001';
const row = {
  id: ID,
  kind: 'slug_claim',
  status: 'open',
  storeId: null,
  userId: 'u1',
  topic: null,
  message: 'we own the brand',
  pageUrl: null,
  slug: 'nike',
  evidenceUrl: 'https://example.com/proof',
  createdAt: '2026-11-14T10:00:00.000Z',
  decidedAt: null as string | null,
};
const route = (calls: string[]) => async (url: string) => {
  calls.push(url);
  if (url.includes(`/trust-requests/${ID}`)) return { data: { request: row }, error: null };
  return { data: { rows: [row], nextCursor: null }, error: null };
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin trust requests page', () => {
  it('an API failure shows the error state, not the empty state', async () => {
    apiGet.mockResolvedValue({ data: null, error: { code: 'X', message: 'boom', status: 500 } });
    render(<TrustRequestsPage />);
    expect((await screen.findByRole('alert')).textContent).toBe('loadFailed');
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('lists open requests by default and sends the chosen filters to the API', async () => {
    const calls: string[] = [];
    apiGet.mockImplementation(route(calls));
    render(<TrustRequestsPage />);
    await screen.findByText('kind.slug_claim', { selector: 'td' });
    expect(calls[0]).toContain('status=open');
    fireEvent.change(screen.getByLabelText('filter.kind'), { target: { value: 'store_cap' } });
    await waitFor(() => expect(calls.at(-1)).toContain('kind=store_cap'));
    fireEvent.change(screen.getByLabelText('filter.store'), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    await waitFor(() =>
      expect(calls.at(-1)).toContain('storeId=22222222-2222-4222-8222-222222222222')
    );
  });

  it.each([
    ['detail.resolve', 'resolve'],
    ['detail.reject', 'reject'],
  ])('open one, press %s: posts the decision and reloads', async (button, action) => {
    const calls: string[] = [];
    apiGet.mockImplementation(route(calls));
    apiPost.mockResolvedValue({ data: {}, error: null });
    render(<TrustRequestsPage />);
    fireEvent.click(await screen.findByText('detail.open'));
    expect(await screen.findByText('we own the brand', { selector: 'p' })).toBeTruthy();
    const before = calls.length;
    fireEvent.click(screen.getByText(button));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        `/api/v1/admin/trust-requests/${ID}/${action}`,
        undefined
      )
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('resolving a store-limit request sends the new limit; reject sends none', async () => {
    const cap = { ...row, kind: 'store_cap', slug: null };
    apiGet.mockImplementation(async (url: string) =>
      url.includes(`/trust-requests/${ID}`)
        ? { data: { request: cap }, error: null }
        : { data: { rows: [cap], nextCursor: null }, error: null }
    );
    apiPost.mockResolvedValue({ data: {}, error: null });
    render(<TrustRequestsPage />);
    fireEvent.click(await screen.findByText('detail.open'));
    const input = (await screen.findByLabelText(/detail.newLimit/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.click(screen.getByText('detail.resolve'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/api/v1/admin/trust-requests/${ID}/resolve`, {
        limit: 6,
      })
    );
  });

  it('a failed decision shows an error and keeps the request open for review', async () => {
    apiGet.mockImplementation(route([]));
    apiPost.mockResolvedValue({ data: null, error: { code: 'X', message: 'no', status: 409 } });
    render(<TrustRequestsPage />);
    fireEvent.click(await screen.findByText('detail.open'));
    fireEvent.click(await screen.findByText('detail.resolve'));
    expect((await screen.findByText('detail.failed')).getAttribute('role')).toBe('alert');
  });
});

describe('decided date (G19)', () => {
  it('shows when a decided request was decided, and a dash while it is open', async () => {
    const decided = { ...row, id: 'd1', status: 'resolved', decidedAt: '2026-11-15T12:30:00.000Z' };
    apiGet.mockImplementation(async () => ({
      data: { rows: [decided, { ...row, id: 'o1' }], nextCursor: null },
      error: null,
    }));
    render(<TrustRequestsPage />);
    await waitFor(() => expect(screen.getByText('2026-11-15 12:30')).toBeTruthy());
    expect(screen.getByText('col.decided')).toBeTruthy();
  });
});
