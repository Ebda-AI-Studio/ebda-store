// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OrderDetail } from './types';

const { apiGet, apiPost, apiFetch } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../../../../../lib/api', () => ({ apiGet, apiPost, apiFetch }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../../../../../i18n/useT', () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
}));
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: ({ label, ...p }: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      {label}
      <input {...p} />
    </label>
  ),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import { OrderInstapayPanel } from './OrderInstapayPanel';

const order = {
  id: 'o1',
  status: 'awaiting_payment_confirmation',
  updatedAt: '2026-10-05T00:00:00.000Z',
  payments: [{ id: 'p1', provider: 'instapay', status: 'pending', amount: 12000 }],
} as unknown as OrderDetail;

const receipt = {
  id: 'r1',
  kind: 'order',
  status: 'submitted',
  extractionStatus: 'done',
  extracted: null,
  confidence: null,
  fields: {
    amountMinor: 12000,
    reference: '123456789012',
    transferredAt: '2026-10-05T11:35:00.000Z',
    payerName: 'Ahmed',
  },
  expectedAmountMinor: 12000,
  expectedReceiver: null,
  flags: [],
  reviewNote: null,
  submittedAt: null,
  reviewedAt: null,
  createdAt: '2026-10-05T11:30:00.000Z',
};

beforeEach(() => {
  apiGet.mockResolvedValue({ data: { receipts: [receipt] }, error: null });
  apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
  URL.createObjectURL = vi.fn(() => 'blob:r');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPanel = (role: 'store_admin' | 'staff' | 'super_admin', o = order) =>
  render(
    <OrderInstapayPanel
      order={o}
      storeId="s1"
      userRole={role}
      onApprove={() => {}}
      onChanged={() => {}}
    />
  );

describe('OrderInstapayPanel', () => {
  it('shows approve AND reject for an InstaPay order with a submitted receipt', async () => {
    renderPanel('store_admin');
    expect(await screen.findByRole('button', { name: 'approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'reject' })).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/orders/o1/instapay-receipts');
  });

  it('staff can review too', async () => {
    renderPanel('staff');
    expect(await screen.findByRole('button', { name: 'approve' })).toBeTruthy();
  });

  it('super-admin gets no order-receipt UI and no request is made', () => {
    const { container } = renderPanel('super_admin');
    expect(container.textContent).toBe('');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('is absent for a non-InstaPay order', () => {
    const cod = {
      ...order,
      payments: [{ id: 'p', provider: 'cod', status: 'pending' }],
    } as unknown as OrderDetail;
    const { container } = renderPanel('store_admin', cod);
    expect(container.textContent).toBe('');
    expect(apiGet).not.toHaveBeenCalled();
  });
});
