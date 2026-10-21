// @vitest-environment jsdom
/**
 * B2B Task 7: the applications queue. Approve takes an active wholesale group, reject says the note is shown to the applicant,
 * revoke reports what actually happened, a second admin's decision (409) refreshes the list instead of failing silently, and
 * every decision tells the badge to refetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  usePathname: () => '/x',
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const gate = vi.hoisted(() => ({ value: null as React.ReactNode | null }));
vi.mock('../../../../hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: gate.value }),
}));
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}));
const changed = vi.fn();
vi.mock('../../../../hooks/useWholesalePending', () => ({
  notifyWholesalePendingChanged: () => changed(),
}));

import Page from './page';

const ROW = (o: Record<string, unknown> = {}) => ({
  id: 'a1',
  businessName: 'Cairo Traders',
  commercialRegNo: 'CR-1',
  phone: '+201000000123',
  notes: 'resell tea',
  status: 'pending',
  decisionNote: null,
  createdAt: new Date(Date.now() - 50 * 3_600_000).toISOString(),
  decidedAt: null,
  user: { email: 's@x.com', firstName: 'Sara', lastName: 'Ali' },
  ...o,
});
const GROUPS = [
  { id: 'g1', name: 'Wholesale', nameAr: null, isWholesale: true, isActive: true },
  { id: 'g2', name: 'VIP', nameAr: null, isWholesale: false, isActive: true },
  { id: 'g3', name: 'Dormant', nameAr: null, isWholesale: true, isActive: false },
];

function mockApi(rows = [ROW()]) {
  apiGet.mockImplementation(async (url: string) =>
    url.includes('customer-groups')
      ? { data: { groups: GROUPS }, error: null }
      : { data: { items: rows, nextCursor: null }, error: null }
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  changed.mockReset();
  gate.value = null;
});
afterEach(cleanup);

describe('wholesale applications page', () => {
  it('lists the pending queue with the waiting time, flagged once it passes 48 hours', async () => {
    mockApi();
    render(<Page />);
    expect(await screen.findByText('Cairo Traders')).toBeTruthy();
    expect(screen.getByText(/waitingOverdue .*50/)).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(
      expect.stringContaining('/wholesale-applications?status=pending')
    );
  });

  it('approve offers ONLY active wholesale groups, posts the group id, and refreshes the badge', async () => {
    mockApi();
    apiPost.mockResolvedValue({ data: {}, error: null });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'approve' }));
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.textContent)).toEqual(['Wholesale']);
    fireEvent.click(screen.getByRole('button', { name: 'approveConfirm' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/v1/stores/store-1/wholesale-applications/a1/approve',
        { groupId: 'g1' }
      )
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toContain('approvedNotice');
  });

  it('reject tells the merchant the note is shown to the applicant and sends it', async () => {
    mockApi();
    apiPost.mockResolvedValue({ data: {}, error: null });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'reject' }));
    expect(screen.getByText('noteVisibleHint')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not a trader' } });
    fireEvent.click(screen.getByRole('button', { name: 'rejectConfirm' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/v1/stores/store-1/wholesale-applications/a1/reject',
        { note: 'not a trader' }
      )
    );
  });

  it("a 409 from another admin's decision shows the plain message and reloads the list", async () => {
    mockApi();
    apiPost.mockResolvedValue({ data: null, error: { code: 'NOT_PENDING', message: 'x' } });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'approve' }));
    await screen.findByRole('combobox');
    const before = apiGet.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'approveConfirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe('alreadyDecided');
    await waitFor(() => expect(apiGet.mock.calls.length).toBeGreaterThan(before));
  });

  it('revoke reports when the buyer was already outside every wholesale group (never a silent no-op)', async () => {
    mockApi([ROW({ status: 'approved' })]);
    apiPost.mockResolvedValue({ data: { membership: 'already_not_wholesale' }, error: null });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'revokeConfirm' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('revokedAlreadyOut')
    );
  });

  it('without the plan it renders the upgrade prompt, not the queue', () => {
    mockApi();
    gate.value = <div data-testid="upgrade">upgrade</div>;
    render(<Page />);
    expect(screen.getByTestId('upgrade')).toBeTruthy();
  });
});
