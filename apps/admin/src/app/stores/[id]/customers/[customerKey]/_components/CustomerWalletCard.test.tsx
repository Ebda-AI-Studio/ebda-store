// @vitest-environment jsdom
/**
 * Issue 2126 (owner decision 2026-10-01): when a customer deletes their
 * account, the merchant sees ONE narrow line on that customer's wallet
 * history — "Wallet balance written off after the customer deleted their
 * account" (en/ar) — and nothing from the audit log. Mutation-proof:
 * dropping the `erasureWriteOff` branch shows the raw internal note instead
 * and reddens this.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiGet }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/i18n/useT', () => {
  const t = (key: string) => key;
  return { useT: () => t };
});
vi.mock('./WalletAdjustModal', () => ({ WalletAdjustModal: () => null }));

import { CustomerWalletCard } from './CustomerWalletCard';

const entry = (over: Record<string, unknown>) => ({
  id: 'e1',
  amount: -3000,
  balanceAfter: 0,
  type: 'expire',
  note: 'Forfeited on account erasure',
  createdAt: '2026-10-01T10:00:00Z',
  order: null,
  return: null,
  ...over,
});

afterEach(cleanup);

describe('CustomerWalletCard — erasure write-off line (issue 2126)', () => {
  it('shows the narrow translated line, not the internal note', async () => {
    apiGet.mockResolvedValue({
      data: { balance: 0, transactions: [entry({ erasureWriteOff: true })], nextCursor: null },
    });
    render(<CustomerWalletCard storeId="s1" customerId="c1" canAdjust={false} />);
    expect(await screen.findByText('erasureWriteOff')).toBeTruthy();
    expect(screen.queryByText('Forfeited on account erasure')).toBeNull();
  });

  it('an ordinary note still shows as typed (control)', async () => {
    apiGet.mockResolvedValue({
      data: {
        balance: 500,
        transactions: [entry({ type: 'admin_adjust', note: 'goodwill', erasureWriteOff: false })],
        nextCursor: null,
      },
    });
    render(<CustomerWalletCard storeId="s1" customerId="c1" canAdjust={false} />);
    expect(await screen.findByText('goodwill')).toBeTruthy();
    expect(screen.queryByText('erasureWriteOff')).toBeNull();
  });
});
