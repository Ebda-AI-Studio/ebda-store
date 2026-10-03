// @vitest-environment jsdom
/**
 * Issue 2443 — an Approve started on page 1 and resolved after the merchant paged (or switched the
 * status filter) refetched through a `fetchReviews` captured from the old render and painted the OLD
 * page/filter under the new pager, with no stale-response guard. Handlers now bump a refreshKey; the
 * one fetch effect owns every list request and is latest-wins.
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

vi.mock('@/lib/api', () => ({ apiGet, apiPost, apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('@force/ui', () => ({
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Modal: () => null,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/SearchInput', () => ({ SearchInput: () => null }));

import ReviewsPage from './page';

const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const page = Number(qp(d.url, 'page'));
  const status = qp(d.url, 'status');
  d.resolve({
    data: {
      reviews: [
        {
          id: `r${page}`,
          rating: 5,
          title: null,
          body: `REV-${status}-${page}`,
          language: 'en',
          bodyTranslated: null,
          verifiedPurchase: false,
          status: 'pending',
          rejectionReason: null,
          spamScore: null,
          spamReasons: null,
          ownerResponse: null,
          ownerResponseAr: null,
          createdAt: '2026-02-01T00:00:00Z',
          product: { id: 'p1', name: 'Prod', slug: 'prod' },
          customer: null,
        },
      ],
      meta: { page, limit: 20, total: 60, totalPages: 3 },
    },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  posts.length = 0;
  apiGet.mockImplementation((url: string) => new Promise(resolve => calls.push({ url, resolve })));
  apiPost.mockImplementation((url: string) => new Promise(resolve => posts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadFirstPage() {
  render(<ReviewsPage />);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => respond(calls[0]));
  await screen.findByText('REV-all-1');
}

describe('reviews list — post-action refetch reads CURRENT page/filter (issue 2443)', () => {
  it('an Approve resolving after the pager moved repaints the CURRENT page', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('approve')); // POST in flight, started on page 1
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => posts[0].resolve({ error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('REV-all-2')).toBeTruthy();
    expect(screen.queryByText('REV-all-1')).toBeNull();
    expect(qp(calls[calls.length - 1].url, 'page')).toBe('2');
  });

  it('an Approve resolving after the status filter changed repaints the CURRENT filter', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('approve'));
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByText('filterApproved'));
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => posts[0].resolve({ error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('REV-published-1')).toBeTruthy();
    expect(screen.queryByText('REV-all-1')).toBeNull();
    expect(qp(calls[calls.length - 1].url, 'status')).toBe('published');
  });

  it('an older list response landing last never repaints (latest-wins guard)', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(3));

    await act(async () => respond(calls[2])); // page 3 first
    await act(async () => respond(calls[1])); // page 2 lands LAST

    expect(screen.getByText('REV-all-3')).toBeTruthy();
    expect(screen.queryByText('REV-all-2')).toBeNull();
  });
});
