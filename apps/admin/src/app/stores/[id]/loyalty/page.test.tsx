// @vitest-environment jsdom
/**
 * Issues 2451 / 2443 — an award that resolved after the merchant changed the tier filter refetched
 * the members list through a `fetchMembers` captured from the old render (old tier) and painted the
 * OLD tier's members under the new filter. The award now bumps a refreshKey; the effect is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPost, memberCalls, posts } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  memberCalls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  posts: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGet, apiPost, apiPut: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: null }),
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./_components/LoyaltyStatsCards', () => ({ LoyaltyStatsCards: () => null }));
vi.mock('./_components/PointEarningForm', () => ({ PointEarningForm: () => null }));
vi.mock('./_components/TierSettings', () => ({ TierSettings: () => null }));
vi.mock('./_components/RedemptionForm', () => ({ RedemptionForm: () => null }));
vi.mock('./_components/DisableConfirmDialog', () => ({ DisableConfirmDialog: () => null }));
vi.mock('./_components/MembersTable', () => ({
  MembersTable: (props: {
    members: Array<{ customerId: string; name: string }>;
    onTierFilterChange: (t: string) => void;
    onAwardClick: (m: unknown) => void;
  }) => (
    <div>
      {props.members.map(m => (
        <div key={m.customerId}>
          <span>{m.name}</span>
          <button onClick={() => props.onAwardClick({ ...m, customer: { firstName: 'X' } })}>
            award
          </button>
        </div>
      ))}
      <button onClick={() => props.onTierFilterChange('gold')}>tier-gold</button>
      <button onClick={() => props.onTierFilterChange('silver')}>tier-silver</button>
    </div>
  ),
}));
vi.mock('./_components/AwardPointsModal', () => ({
  AwardPointsModal: (props: {
    onPointsChange: (v: string) => void;
    onSubmit: (e: React.FormEvent) => void;
  }) => (
    <form onSubmit={props.onSubmit}>
      <input aria-label="points" onChange={e => props.onPointsChange(e.target.value)} />
      <button type="submit">submit-award</button>
    </form>
  ),
}));

import LoyaltySettingsPage from './page';

const tierOf = (url: string) => new URL(url, 'http://x').searchParams.get('tier') ?? 'all';

function respond(d: Pending) {
  const tier = tierOf(d.url);
  d.resolve({
    data: { members: [{ customerId: `c-${tier}`, name: `MEMBER-${tier}` }] },
    error: null,
  });
}

beforeEach(() => {
  memberCalls.length = 0;
  posts.length = 0;
  apiGet.mockImplementation((url: string) => {
    if (url.endsWith('/loyalty/settings'))
      return Promise.resolve({ data: { loyaltyEnabled: true, settings: {} } });
    if (url.endsWith('/loyalty/stats')) return Promise.resolve({ data: null });
    return new Promise(resolve => memberCalls.push({ url, resolve }));
  });
  apiPost.mockImplementation((url: string) => new Promise(resolve => posts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openMembers() {
  render(<LoyaltySettingsPage />);
  await waitFor(() => expect(memberCalls).toHaveLength(1));
  await act(async () => respond(memberCalls[0]));
  fireEvent.click(await screen.findByText('tabs.members'));
  await screen.findByText('MEMBER-all');
}

describe('loyalty members — post-award refetch reads the CURRENT tier (issues 2451, 2443)', () => {
  it('an award resolving after the tier filter changed repaints the CURRENT tier', async () => {
    await openMembers();
    fireEvent.click(screen.getByText('award'));
    fireEvent.change(await screen.findByLabelText('points'), { target: { value: '10' } });
    fireEvent.click(screen.getByText('submit-award')); // POST in flight, started under tier "all"
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByText('tier-gold'));
    await waitFor(() => expect(memberCalls).toHaveLength(2));

    await act(async () => posts[0].resolve({ error: null }));
    await waitFor(() => expect(memberCalls.length).toBeGreaterThanOrEqual(3));
    for (const c of memberCalls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('MEMBER-gold')).toBeTruthy();
    expect(screen.queryByText('MEMBER-all')).toBeNull();
    expect(tierOf(memberCalls[memberCalls.length - 1].url)).toBe('gold');
  });

  it('an older members response landing last never repaints (latest-wins guard)', async () => {
    await openMembers();
    fireEvent.click(screen.getByText('tier-gold'));
    await waitFor(() => expect(memberCalls).toHaveLength(2));
    fireEvent.click(screen.getByText('tier-silver'));
    await waitFor(() => expect(memberCalls).toHaveLength(3));

    await act(async () => respond(memberCalls[2])); // silver first
    await act(async () => respond(memberCalls[1])); // gold lands LAST

    expect(screen.getByText('MEMBER-silver')).toBeTruthy();
    expect(screen.queryByText('MEMBER-gold')).toBeNull();
  });
});
