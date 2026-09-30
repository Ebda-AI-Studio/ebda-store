// @vitest-environment jsdom
/**
 * Issue 2375's class on the third super-admin ops page: apiGet resolves
 * `{ data: null, error }` on a 403/500/outage (it never throws), so the old
 * catch was unreachable and an outage rendered as "No webhook events".
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

import WebhookEventsPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin webhook events page — load failure (issue 2375 class)', () => {
  it('shows the load-failure state, not "empty", when the API errors', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'boom', status: 500 },
    });
    render(<WebhookEventsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('failedToLoad');
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('a genuinely empty inbox still reads "empty" (control)', async () => {
    apiGet.mockResolvedValue({ data: { events: [] }, error: null });
    render(<WebhookEventsPage />);

    expect(await screen.findByText('empty')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
