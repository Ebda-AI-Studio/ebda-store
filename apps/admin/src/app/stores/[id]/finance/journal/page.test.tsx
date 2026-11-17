// @vitest-environment jsdom
/**
 * Issue 2436 — a date-window change on the journal list fired TWO requests (the new window at the
 * OLD page, then at page 1) and nothing discarded the stale response, so whichever landed last
 * painted rows that did not match the page or window the UI claimed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Deferred = {
  url: string;
  resolve: (v: unknown) => void;
};

const { apiGetPage, calls } = vi.hoisted(() => ({
  apiGetPage: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGetPage }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }));
vi.mock('@/contexts/NotificationContext', () => ({
  useNotifications: () => ({ subscribeToStore: vi.fn(), unsubscribeFromStore: vi.fn() }),
  useUiRefresh: vi.fn(),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/lib/format', () => ({
  minorToMajor: (n: number) => String(n),
  intlLocaleForUi: () => 'en-US',
}));
vi.mock('../../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../../components/DateRangePicker', () => ({
  DateRangePicker: ({ onChange }: { onChange: (p: string, c?: unknown) => void }) => (
    <button onClick={() => onChange('last_month')}>change-window</button>
  ),
}));
vi.mock('../../../../../components/PageControls', () => ({
  PageControls: ({
    meta,
    onPageChange,
  }: {
    meta: { page: number } | null;
    onPageChange: (p: number) => void;
  }) => (
    <div>
      <span data-testid="meta-page">{meta?.page}</span>
      <button onClick={() => onPageChange(2)}>go-2</button>
      <button onClick={() => onPageChange(3)}>go-3</button>
    </div>
  ),
}));

import JournalListPage from './page';

const pageOf = (url: string) => Number(new URL(url, 'http://x').searchParams.get('page'));

function respond(d: Deferred) {
  const page = pageOf(d.url);
  d.resolve({
    data: [
      {
        id: `e${page}`,
        entryNumber: `JE-PAGE-${page}`,
        postedAt: '2026-02-01T00:00:00Z',
        source: 'manual',
        memo: null,
        status: 'posted',
        lines: [],
      },
    ],
    meta: { page, perPage: 100, total: 250, totalPages: 3 },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  apiGetPage.mockImplementation(
    (url: string) => new Promise(resolve => calls.push({ url, resolve }))
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadFirstPage() {
  render(<JournalListPage />);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => respond(calls[0]));
  await screen.findByText('JE-PAGE-1');
}

describe('journal list — one request per window change, latest wins (issue 2436)', () => {
  it('a window change from page 3 sends exactly ONE request, for page 1', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('go-3'));
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => respond(calls[1]));
    await screen.findByText('JE-PAGE-3');

    fireEvent.click(screen.getByText('change-window'));
    await act(async () => {});

    const issued = calls.slice(2);
    expect(issued.map(c => pageOf(c.url))).toEqual([1]);
  });

  it('a stale response that lands last does not repaint the table', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('go-2')); // request A (page 2)
    fireEvent.click(screen.getByText('go-3')); // request B (page 3), newest
    await waitFor(() => expect(calls).toHaveLength(3));

    await act(async () => respond(calls[2])); // newest lands first
    await act(async () => respond(calls[1])); // the stale one lands last

    expect(screen.getByText('JE-PAGE-3')).toBeTruthy();
    expect(screen.queryByText('JE-PAGE-2')).toBeNull();
    expect(screen.getByTestId('meta-page').textContent).toBe('3');
  });
});
