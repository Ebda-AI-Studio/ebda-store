// @vitest-environment jsdom
/**
 * Scoped audit, PR 1978:
 *  - P2: the list silently capped at 200 rows — no total, no notice, no way
 *    to reach an older redirect.
 *  - P3: one failed DELETE early-returned the whole page into a bare error
 *    sentence (table gone, no retry), and a failed LOAD displayed the
 *    "Loading redirects..." string as its error message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiDelete } = vi.hoisted(() => ({ apiGet: vi.fn(), apiDelete: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiGet, apiDelete }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

// The delete step asks through useConfirm(): answer yes.
vi.mock('@/hooks/useConfirm', () => {
  const yes = async () => true;
  return { useConfirm: () => yes };
});

import SlugRedirectsPage from './page';

const row = (id: string, fromSlug = `old-${id}`) => ({
  id,
  entityType: 'PRODUCT',
  fromSlug,
  toSlug: `new-${id}`,
  createdAt: '2026-09-20T10:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('slug redirects page', () => {
  it('says how many rows were withheld when the list is capped', async () => {
    apiGet.mockResolvedValue({ data: { rows: [row('a')], total: 731, limit: 1 }, error: null });
    render(<SlugRedirectsPage />);
    expect(await screen.findByText('redirectsShowingOf:{"shown":1,"total":731}')).toBeTruthy();
  });

  it('shows no cap notice when every row fits', async () => {
    apiGet.mockResolvedValue({ data: { rows: [row('a')], total: 1, limit: 200 }, error: null });
    render(<SlugRedirectsPage />);
    await screen.findByText('old-a');
    expect(screen.queryByText(/redirectsShowingOf/)).toBeNull();
  });

  it('sends the search as ?q= to the API', async () => {
    apiGet.mockResolvedValue({ data: { rows: [], total: 0, limit: 200 }, error: null });
    render(<SlugRedirectsPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' linen shirt ' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() =>
      expect(apiGet).toHaveBeenLastCalledWith(
        '/api/v1/stores/store-1/slug-redirects?q=linen%20shirt'
      )
    );
  });

  it('a failed delete keeps the table mounted and shows a dismissible banner', async () => {
    apiGet.mockResolvedValue({
      data: { rows: [row('a'), row('b')], total: 2, limit: 200 },
      error: null,
    });
    apiDelete.mockResolvedValue({ data: null, error: { code: 'X', message: 'boom' } });
    render(<SlugRedirectsPage />);
    fireEvent.click((await screen.findAllByText('redirectsDelete'))[0]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('redirectsDeleteError');
    // The rows the merchant was working through are still there.
    expect(screen.getByText('old-a')).toBeTruthy();
    expect(screen.getByText('old-b')).toBeTruthy();

    fireEvent.click(screen.getByText('redirectsDismiss'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed load shows a real error (not the loading string) with a working retry', async () => {
    apiGet.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({
      data: { rows: [row('a')], total: 1, limit: 200 },
      error: null,
    });
    render(<SlugRedirectsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('redirectsLoadError');
    expect(alert.textContent).not.toContain('redirectsLoading');

    fireEvent.click(screen.getByText('redirectsRetry'));
    expect(await screen.findByText('old-a')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Issue 2255: rows past the first page were reachable only by searching for
  // a slug the merchant already knew. "Load more" pages through all of them.
  it('pages through every row with Load more, appending the next page', async () => {
    apiGet
      .mockResolvedValueOnce({
        data: { rows: [row('a'), row('b')], total: 3, limit: 2, nextCursor: 'b' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { rows: [row('c')], total: 3, limit: 2, nextCursor: null },
        error: null,
      });
    render(<SlugRedirectsPage />);
    await screen.findByText('old-a');

    fireEvent.click(screen.getByText('redirectsLoadMore'));

    expect(await screen.findByText('old-c')).toBeTruthy();
    expect(screen.getByText('old-a')).toBeTruthy();
    expect(String(apiGet.mock.calls[1][0])).toContain('cursor=b');
    // Last page: no more button, and no "showing N of M" notice.
    await waitFor(() => expect(screen.queryByText('redirectsLoadMore')).toBeNull());
    expect(screen.queryByText(/redirectsShowingOf/)).toBeNull();
  });
});
