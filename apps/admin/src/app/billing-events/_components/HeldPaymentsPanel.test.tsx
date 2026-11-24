// @vitest-environment jsdom
/**
 * Ruling ADDON-HELD-CREDIT-A: nothing can write a hand credit for an add-on, so the resolve dialog of a held ADD-ON payment offers only
 * "refunded" and "not ours" (with the reason), while a plan payment keeps all three, and the "credited" help only shows with "credited".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('../../../i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Input: ({ label, ...p }: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={p.id}>{label}</label>
      <input {...p} />
    </div>
  ),
  Modal: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));

import { HeldPaymentsPanel } from './HeldPaymentsPanel';

const held = (id: string, isAddon: boolean) => ({
  id,
  provider: 'stub',
  eventId: `settle:${id}`,
  receivedAt: '2026-11-24T10:00:00.000Z',
  status: 'open',
  reason: 'amount_mismatch',
  expectedMinor: 4000,
  gotMinor: 5000,
  expectedCurrency: 'EGP',
  gotCurrency: 'EGP',
  isAddon,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openResolve = async (rows: unknown[]) => {
  apiGet.mockResolvedValue({ data: { held: rows }, error: null });
  render(<HeldPaymentsPanel refreshKey={0} onChanged={() => undefined} />);
  const buttons = await screen.findAllByRole('button', { name: 'resolve' });
  fireEvent.click(buttons[0]!);
};

describe('held payments resolve dialog', () => {
  it('an ADD-ON payment offers refunded and not ours only, explains why, and preselects refunded', async () => {
    await openResolve([held('h1', true)]);
    expect(screen.queryByText('actions.credited')).toBeNull();
    expect(screen.getByText('actions.refunded')).toBeTruthy();
    expect(screen.getByText('actions.not_ours')).toBeTruthy();
    expect(screen.getByText('addonNoCreditHelp')).toBeTruthy();
    expect(screen.queryByText('creditedHelp')).toBeNull();
    const refunded = screen.getByLabelText('actions.refunded') as HTMLInputElement;
    expect(refunded.checked).toBe(true);
  });

  it('a PLAN payment keeps all three actions, preselects credited and shows the credited help', async () => {
    await openResolve([held('h2', false)]);
    expect(screen.getByText('actions.credited')).toBeTruthy();
    expect(screen.getByText('actions.refunded')).toBeTruthy();
    expect(screen.getByText('actions.not_ours')).toBeTruthy();
    expect(screen.getByText('creditedHelp')).toBeTruthy();
    expect(screen.queryByText('addonNoCreditHelp')).toBeNull();
    expect((screen.getByLabelText('actions.credited') as HTMLInputElement).checked).toBe(true);
  });
});
