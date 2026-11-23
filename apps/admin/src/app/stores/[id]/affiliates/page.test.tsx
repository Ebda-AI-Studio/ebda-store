// @vitest-environment jsdom
/**
 * Issues 2450 / 2443 — an Approve started on page 1 and resolved after the merchant paged (or
 * switched the status pill) refetched through a `fetchAffiliates` captured from the old render and
 * painted the OLD page/status under the new pager, with no stale-response guard at all. Handlers now
 * bump a refreshKey; the one fetch effect owns every list request and is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPatch, apiPost, calls, patches } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  patches: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', async importActual => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  apiGet,
  apiPatch,
  apiPost,
  apiPut: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('@ebda/ui', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: null }),
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({
    children,
    actions,
  }: {
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock('@/components/SearchInput', () => ({ SearchInput: () => null }));
vi.mock('./_components/AffiliateStatsCards', () => ({ AffiliateStatsCards: () => null }));
vi.mock('./_components/AffiliateCommissionForm', () => ({ AffiliateCommissionForm: () => null }));
vi.mock('./_components/PayoutsHistory', () => ({ PayoutsHistory: () => null }));
vi.mock('./_components/AffiliatesTable', () => ({
  AffiliatesTable: (props: {
    affiliates: Array<{ id: string; name: string }>;
    onStatusAction: (a: { id: string; name: string }, action: string) => void;
    onStatusFilterChange: (s: string) => void;
    onPageChange: (fn: (p: number) => number) => void;
  }) => (
    <div>
      {props.affiliates.map(a => (
        <div key={a.id}>
          <span>{a.name}</span>
          <button onClick={() => props.onStatusAction(a, 'approve')}>approve-{a.id}</button>
        </div>
      ))}
      <button onClick={() => props.onPageChange(p => p + 1)}>next</button>
      <button onClick={() => props.onStatusFilterChange('approved')}>pill-approved</button>
    </div>
  ),
}));

import AffiliatesPage from './page';

const listCalls = () => calls.filter(c => /\/affiliates\?/.test(c.url));
const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const page = Number(qp(d.url, 'page'));
  const status = qp(d.url, 'status') ?? 'all';
  d.resolve({
    data: {
      affiliates: [{ id: `a${page}`, name: `AFF-${status}-${page}` }],
      meta: { page, limit: 20, total: 60, totalPages: 3 },
    },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  patches.length = 0;
  apiGet.mockImplementation((url: string) => {
    if (/\/affiliates\/(stats|config)/.test(url)) return Promise.resolve({ data: null });
    return new Promise(resolve => calls.push({ url, resolve }));
  });
  apiPatch.mockImplementation(
    (url: string) => new Promise(resolve => patches.push({ url, resolve }))
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadFirstPage() {
  render(<AffiliatesPage />);
  await waitFor(() => expect(listCalls()).toHaveLength(1));
  await act(async () => respond(listCalls()[0]));
  await screen.findByText('AFF-all-1');
}

describe('affiliates list — post-action refetch reads CURRENT page/status (issues 2450, 2443)', () => {
  it('an Approve resolving after the pager moved repaints the CURRENT page', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('approve-a1')); // PATCH in flight, started on page 1
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    await act(async () => patches[0].resolve({ error: null }));
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of listCalls().slice(1)) await act(async () => respond(c));

    expect(screen.getByText('AFF-all-2')).toBeTruthy();
    expect(screen.queryByText('AFF-all-1')).toBeNull();
    expect(qp(listCalls()[listCalls().length - 1].url, 'page')).toBe('2');
  });

  it('an Approve resolving after the status pill changed repaints the CURRENT status', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('approve-a1'));
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.click(screen.getByText('pill-approved'));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    await act(async () => patches[0].resolve({ error: null }));
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of listCalls().slice(1)) await act(async () => respond(c));

    expect(screen.getByText('AFF-approved-1')).toBeTruthy();
    expect(screen.queryByText('AFF-all-1')).toBeNull();
    expect(qp(listCalls()[listCalls().length - 1].url, 'status')).toBe('approved');
  });

  it('an older list response landing last never repaints (latest-wins guard)', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(listCalls()).toHaveLength(3));

    await act(async () => respond(listCalls()[2])); // page 3 first
    await act(async () => respond(listCalls()[1])); // page 2 lands LAST

    expect(screen.getByText('AFF-all-3')).toBeTruthy();
    expect(screen.queryByText('AFF-all-2')).toBeNull();
  });
});

describe('affiliate invite form — API field errors', () => {
  it('shows the email error under the email field', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { message: 'bad', status: 400, details: { email: ['Email already invited'] } },
    });
    await loadFirstPage();
    fireEvent.click(screen.getByText('inviteButton'));
    const inputs = document.querySelectorAll('form input');
    fireEvent.change(inputs[0], { target: { value: 'Sara' } });
    fireEvent.change(inputs[1], { target: { value: 'sara@x.com' } });
    fireEvent.submit(inputs[0].closest('form')!);
    expect(await screen.findByText('Email already invited')).toBeTruthy();
  });
});
