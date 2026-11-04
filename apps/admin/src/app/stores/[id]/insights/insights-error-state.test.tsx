// @vitest-environment jsdom
/**
 * UX:AN-2 - an insights page whose API call fails shows the shared error state with a Retry button (never bare red
 * text carrying the API message), and Retry calls the API again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/api', () => ({ apiGet }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const stableT = (key: string) => key; // a stable identity: the segments effect lists `t` as a dependency
vi.mock('@/i18n/useT', () => ({ useT: () => stableT }));

import CohortsPage from './cohorts/page';
import SegmentsPage from './segments/page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each([
  ['cohorts', CohortsPage],
  ['segments', SegmentsPage],
])('insights/%s error state', (_name, Page) => {
  it('shows the retry state for a failed call and retries on click', async () => {
    apiGet.mockResolvedValue({ data: null, error: { message: 'Too many requests', status: 429 } });
    render(<Page />);
    const retry = await screen.findByText('defaultRetry');
    expect(screen.getByText('Too many requests')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
});
