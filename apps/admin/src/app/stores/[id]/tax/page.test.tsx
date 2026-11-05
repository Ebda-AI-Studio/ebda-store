// @vitest-environment jsdom
/**
 * Issue 2443 — a rate toggle/delete resolving after the merchant switched the Active/Inactive pill
 * refetched through a `fetchRates` captured from the old render (old filter) with no stale-response
 * guard, so the previous filter's rows were painted under the new pill. Mutations now bump a
 * refreshKey so the refetch reads the CURRENT filter, and the fetch is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPatch, calls, patches } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  patches: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({
  apiGet,
  apiPatch,
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./_components/TaxGeneralSettings', () => ({ TaxGeneralSettings: () => null }));
vi.mock('./_components/TaxVerificationCard', () => ({ TaxVerificationCard: () => null }));
vi.mock('./_components/EtaConnectionCard', () => ({ EtaConnectionCard: () => null }));
vi.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => false, isLoading: false }),
}));
vi.mock('./_components/TaxTimeZoneCard', () => ({ TaxTimeZoneCard: () => null }));
vi.mock('./_components/TaxInfoBox', () => ({ TaxInfoBox: () => null }));
vi.mock('./_components/TaxRateFormModal', () => ({ TaxRateFormModal: () => null }));
vi.mock('./_components/TaxRatesTable', () => ({
  TaxRatesTable: (props: {
    rates: Array<{ id: string; name: string }>;
    onFilterChange: (f: string) => void;
    onToggle: (r: { id: string; name: string }) => void;
  }) => (
    <div>
      {props.rates.map(r => (
        <span key={r.id}>{r.name}</span>
      ))}
      <button onClick={() => props.onToggle(props.rates[0])}>toggle-first</button>
      <button onClick={() => props.onFilterChange('inactive')}>pill-inactive</button>
    </div>
  ),
}));

import TaxPage from './page';

const rateCalls = () => calls.filter(c => c.url.includes('/tax/rates'));

// Same payload for every request: the page narrows it client-side by the filter of the request's
// own closure, so which closure repaints last is observable in the rows shown.
const respond = (d: Pending) =>
  d.resolve({
    data: {
      rates: [
        { id: 'r1', name: 'RATE-ACTIVE', rate: 5, isActive: true },
        { id: 'r2', name: 'RATE-INACTIVE', rate: 1, isActive: false },
      ],
    },
  });

beforeEach(() => {
  calls.length = 0;
  patches.length = 0;
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/tax/settings')) return Promise.resolve({ data: { settings: {} } });
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

async function loadAll() {
  render(<TaxPage />);
  await waitFor(() => expect(rateCalls()).toHaveLength(1));
  await act(async () => respond(rateCalls()[0]));
  await screen.findByText('RATE-ACTIVE');
  expect(screen.getByText('RATE-INACTIVE')).toBeTruthy();
}

describe('tax rates — refetch reads the CURRENT filter, latest wins (issue 2443)', () => {
  it('a toggle resolving after the pill changed repaints the CURRENT filter', async () => {
    await loadAll();
    fireEvent.click(screen.getByText('toggle-first')); // PATCH in flight, started under "all"
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.click(screen.getByText('pill-inactive'));
    await waitFor(() => expect(rateCalls()).toHaveLength(2));

    await act(async () => patches[0].resolve({}));
    await waitFor(() => expect(rateCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of rateCalls().slice(1)) await act(async () => respond(c));

    expect(screen.getByText('RATE-INACTIVE')).toBeTruthy();
    expect(screen.queryByText('RATE-ACTIVE')).toBeNull();
  });

  it('an older refetch landing last never repaints (latest-wins guard)', async () => {
    await loadAll();
    fireEvent.click(screen.getByText('toggle-first'));
    fireEvent.click(screen.getByText('toggle-first')); // two writes in flight at once
    await waitFor(() => expect(patches).toHaveLength(2));
    await act(async () => patches[0].resolve({}));
    await waitFor(() => expect(rateCalls()).toHaveLength(2));
    await act(async () => patches[1].resolve({}));
    await waitFor(() => expect(rateCalls()).toHaveLength(3));

    const labelled = (d: Pending, name: string) =>
      d.resolve({ data: { rates: [{ id: name, name, rate: 5, isActive: true }] } });
    await act(async () => labelled(rateCalls()[2], 'RATE-NEWEST')); // newest first
    await act(async () => labelled(rateCalls()[1], 'RATE-OLDER')); // older lands LAST

    expect(screen.getByText('RATE-NEWEST')).toBeTruthy();
    expect(screen.queryByText('RATE-OLDER')).toBeNull();
  });
});
