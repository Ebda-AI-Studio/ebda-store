// @vitest-environment jsdom
/** UX:CU-1 - a failed log fetch is an error with a retry, not an empty table. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../../lib/api', () => ({ apiGet }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../i18n/useT', () => ({
  useT: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`,
}));
vi.mock('@/i18n/useT', () => ({
  useT: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`,
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/ai/AiUsageSummaryCard', () => ({ AiUsageSummaryCard: () => null }));
vi.mock('../../../../components/ai/AiSwitchCard', () => ({ AiSwitchCard: () => null }));
vi.mock('../../../../components/AdminSkeleton', () => ({
  AdminSkeletonPage: () => <div data-testid="skeleton" />,
}));

import AiUsagePage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('store ai-usage log states', () => {
  it('shows the localized error with a retry that refetches', async () => {
    apiGet.mockResolvedValueOnce({ error: { code: 'SERVER_ERROR', status: 500, message: 'x' } });
    render(<AiUsagePage />);
    expect(await screen.findByText('aiUsage.table.loadError')).toBeTruthy();
    apiGet.mockResolvedValueOnce({
      data: { rows: [], total: 0, page: 1, pageSize: 20, pages: 0 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'components.errorState.defaultRetry' }));
    expect(await screen.findByText('aiUsage.table.empty')).toBeTruthy();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
});
