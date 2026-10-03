// @vitest-environment jsdom
/**
 * Issue 2443 — approve/reject/markReceived/complete refetched through `fetchReturns` captured from
 * the render the action started in (old page/filter), claimed the newest request slot and repainted
 * stale rows. `refreshAll` now bumps a key the one fetch effect depends on, and the list fetch is
 * latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@force/ui', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), addToast: vi.fn() }),
}));

type Pending = { url: string; resolve: (v: unknown) => void };
const calls: Pending[] = [];
const posts: Pending[] = [];
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}));

import { useReturns } from './useReturns';

const listCalls = () => calls.filter(c => /returns\/admin\/list/.test(c.url));
const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const page = Number(qp(d.url, 'page'));
  const status = qp(d.url, 'status') ?? 'all';
  d.resolve({
    data: {
      returns: [{ id: `ret${page}-${status}` }],
      meta: { page, limit: 20, total: 60, totalPages: 3 },
    },
    error: null,
  });
}

function setup() {
  return renderHook(() =>
    useReturns({
      storeId: 'store-1',
      requestRejectReason: vi.fn().mockResolvedValue(null),
      requestRefundMethod: vi.fn().mockResolvedValue('original'),
    })
  );
}

const ids = (r: { current: { returns: Array<{ id: string }> } }) =>
  r.current.returns.map(x => x.id);

beforeEach(() => {
  calls.length = 0;
  posts.length = 0;
  apiGet.mockImplementation((url: string) => {
    if (/returns\/admin\/stats/.test(url)) return Promise.resolve({ data: null });
    return new Promise(resolve => calls.push({ url, resolve }));
  });
  apiPost.mockImplementation((url: string) => new Promise(resolve => posts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadFirstPage() {
  const hook = setup();
  await waitFor(() => expect(listCalls()).toHaveLength(1));
  await act(async () => respond(listCalls()[0]));
  await waitFor(() => expect(ids(hook.result)).toEqual(['ret1-all']));
  return hook;
}

describe('useReturns — post-action refetch reads CURRENT page/filter (issue 2443)', () => {
  it('an approve resolving after the pager moved repaints the CURRENT page', async () => {
    const { result } = await loadFirstPage();
    let approved: Promise<boolean>;
    act(() => {
      approved = result.current.approve('ret1-all'); // POST in flight, started on page 1
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    act(() => result.current.setPage(2));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    await act(async () => {
      posts[0].resolve({ error: null });
      await approved;
    });
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of listCalls().slice(1)) await act(async () => respond(c));

    await waitFor(() => expect(ids(result)).toEqual(['ret2-all']));
    expect(qp(listCalls()[listCalls().length - 1].url, 'page')).toBe('2');
  });

  it('an approve resolving after the filter changed repaints the CURRENT filter', async () => {
    const { result } = await loadFirstPage();
    let approved: Promise<boolean>;
    act(() => {
      approved = result.current.approve('ret1-all');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    act(() => result.current.changeFilter('pending'));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    await act(async () => {
      posts[0].resolve({ error: null });
      await approved;
    });
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of listCalls().slice(1)) await act(async () => respond(c));

    await waitFor(() => expect(ids(result)).toEqual(['ret1-pending']));
    expect(qp(listCalls()[listCalls().length - 1].url, 'status')).toBe('pending');
  });

  it('an older list response landing last never repaints (latest-wins guard)', async () => {
    const { result } = await loadFirstPage();
    act(() => result.current.setPage(2));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    act(() => result.current.setPage(3));
    await waitFor(() => expect(listCalls()).toHaveLength(3));

    await act(async () => respond(listCalls()[2])); // page 3 first
    await act(async () => respond(listCalls()[1])); // page 2 lands LAST

    await waitFor(() => expect(ids(result)).toEqual(['ret3-all']));
  });
});
