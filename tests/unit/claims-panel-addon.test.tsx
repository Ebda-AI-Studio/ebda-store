// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../apps/admin/src/lib/api', () => ({ apiGet: api.get, apiPost: api.post }));
vi.mock('../../apps/admin/src/i18n/useT', () => ({
  useT: () => (k: string) => k,
}));
vi.mock('../../apps/admin/src/hooks/useLatestRequest', () => {
  const begin = () => () => true; // stable identity: the panel refetches when it changes
  return { useLatestRequest: () => begin };
});
vi.mock('../../apps/admin/src/components/mobile/DataTable', () => ({
  DataTable: ({
    rows,
    columns,
  }: {
    rows: unknown[];
    columns: Array<{ header: string; cell: (r: any) => React.ReactNode }>;
  }) => (
    <div>
      {rows.map((r: any) => (
        <div key={r.id} data-testid={`row-${r.id}`}>
          {columns.find(c => c.header === 'columns.action')!.cell(r)}
        </div>
      ))}
    </div>
  ),
}));

import { ClaimsPanel } from '../../apps/admin/src/app/billing-events/_components/ClaimsPanel';

const claim = (over: Record<string, unknown>) => ({
  id: 'c1',
  storeId: '11111111-1111-4111-8111-111111111111',
  storeName: 'Shop',
  storeSlug: 'shop',
  storeStatus: 'active',
  planCode: 'addon:feature:loyalty',
  isAddon: true,
  billingInterval: 'monthly',
  amountMinor: 9900,
  method: 'instapay',
  paymentReference: 'EBD-X',
  payerReference: 'TXN1',
  proofUrl: null,
  status: 'pending',
  createdAt: '2026-11-15T00:00:00Z',
  receipt: null,
  ...over,
});

afterEach(() => cleanup());

describe('ClaimsPanel: an add-on claim has its own approval', () => {
  it('Confirm on an add-on claim posts approve-addon and NEVER opens the plan payment form', async () => {
    api.get.mockResolvedValue({ data: { claims: [claim({})] } });
    api.post.mockResolvedValue({ data: { billingEventId: 'e1' } });
    const onConfirm = vi.fn();
    const onChanged = vi.fn();
    render(<ClaimsPanel refreshKey={0} onConfirm={onConfirm} onChanged={onChanged} />);
    fireEvent.click(await screen.findByText('confirm'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][0]).toBe('/api/v1/admin/billing/claims/c1/approve-addon');
    expect(api.post.mock.calls[0][1]).toEqual({ storeId: '11111111-1111-4111-8111-111111111111' });
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('addonApproved'));
  });

  it('a PLAN claim still opens the manual payment form', async () => {
    api.post.mockClear();
    api.get.mockResolvedValue({
      data: { claims: [claim({ id: 'c2', planCode: 'growth', isAddon: false })] },
    });
    const onConfirm = vi.fn();
    render(<ClaimsPanel refreshKey={0} onConfirm={onConfirm} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByText('confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
  });
});
