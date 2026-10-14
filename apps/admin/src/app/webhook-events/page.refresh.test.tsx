// @vitest-environment jsdom
/**
 * Issue 2443 — a replay started under one status filter and resolved after the admin switched the
 * filter refetched through a `fetchEvents` captured from the old render and painted the OLD filter's
 * rows, with no stale-response guard. replay() now bumps a refreshKey; the one fetch effect owns every
 * list request and is latest-wins.
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

vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string) => key;
  return { useT: () => t };
});
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

import WebhookEventsPage from './page';

const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const status = qp(d.url, 'status') ?? 'all';
  d.resolve({
    data: {
      events: [
        {
          id: `ev-${status}`,
          provider: `EVT-${status}`,
          storeId: null,
          status: 'failed',
          attempts: 1,
          lastError: null,
          resultOrderId: null,
          resultStatus: null,
          idempotencyKey: `k-${status}`,
          receivedAt: '2026-02-01T00:00:00Z',
        },
      ],
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

async function loadAll() {
  render(<WebhookEventsPage />);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => respond(calls[0]));
  await screen.findByText('EVT-all');
}

describe('webhook events — post-replay refetch reads the CURRENT status filter (issue 2443)', () => {
  it('a replay resolving after the filter changed repaints the CURRENT filter', async () => {
    await loadAll();
    fireEvent.click(screen.getByText('replay')); // POST in flight, started under "all"
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByText('processed'));
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => posts[0].resolve({ data: {}, error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('EVT-processed')).toBeTruthy();
    expect(screen.queryByText('EVT-all')).toBeNull();
    expect(qp(calls[calls.length - 1].url, 'status')).toBe('processed');
  });

  it('an older list response landing last never repaints (latest-wins guard)', async () => {
    await loadAll();
    fireEvent.click(screen.getByText('failed', { selector: 'button' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByText('processed'));
    await waitFor(() => expect(calls).toHaveLength(3));

    await act(async () => respond(calls[2])); // processed first
    await act(async () => respond(calls[1])); // failed lands LAST

    expect(screen.getByText('EVT-processed')).toBeTruthy();
    expect(screen.queryByText('EVT-failed')).toBeNull();
  });
});
