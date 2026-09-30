// @vitest-environment jsdom
/**
 * Issue 2367 — the email-queue twin of the sms-queue defect: "Retry all"
 * was gated on the READABLE row count (`emails.length`) instead of the
 * authoritative server-side `stats.failed`. When every `email:failed`
 * entry is unparseable, `emails` is empty and the button — the only way
 * to move them to `email:failed:corrupt` — was greyed out with no way to
 * drain the list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost: vi.fn() }));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import EmailQueuePage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin email queue page (issue 2367)', () => {
  it('keeps "Retry all" enabled when stats.failed > 0 but every row is unreadable', async () => {
    apiGet.mockResolvedValue({
      data: { emails: [], stats: { pending: 0, failed: 3, corrupt: 0 }, corrupt: [] },
      error: null,
    });
    render(<EmailQueuePage />);

    const button = await screen.findByRole('button', { name: 'retryAll' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('emptyUnreadable')).toBeTruthy();
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('disables "Retry all" when stats.failed is genuinely 0', async () => {
    apiGet.mockResolvedValue({
      data: { emails: [], stats: { pending: 0, failed: 0, corrupt: 0 }, corrupt: [] },
      error: null,
    });
    render(<EmailQueuePage />);

    const button = await screen.findByRole('button', { name: 'retryAll' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('empty')).toBeTruthy();
  });

  it('falls back to the parsed row count when stats is null (Redis down)', async () => {
    apiGet.mockResolvedValue({ data: null, error: null });
    render(<EmailQueuePage />);

    const button = await screen.findByRole('button', { name: 'retryAll' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
