// @vitest-environment jsdom
/** Smart hints page: the merchant's switches, the "not enough data yet" state, and the amount card. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('../../../../lib/api', () => api);
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import Page from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const overview = (o: object = {}) => ({
  data: {
    hintsEnabled: true,
    ciSharing: false,
    gates: [],
    fee: { status: 'insufficient', suggestion: null },
    aggregates: { storeAsOf: null, cohortAsOf: null },
    shown30d: [],
    ...o,
  },
});

describe('Smart hints page', () => {
  it('says "not enough data yet" instead of a number', async () => {
    api.apiGet.mockResolvedValue(overview());
    render(<Page />);
    expect(await screen.findByText('notEnough')).toBeTruthy();
    expect(screen.queryByText(/fee\.suggestion/)).toBeNull();
  });

  it('hides everything but the two switches while hints are off', async () => {
    api.apiGet.mockResolvedValue(overview({ hintsEnabled: false }));
    render(<Page />);
    expect(await screen.findByText('hints.off')).toBeTruthy();
    expect(screen.queryByText('fee.title')).toBeNull();
  });

  it('shows the amount suggestion with its n', async () => {
    api.apiGet.mockResolvedValue(
      overview({
        fee: {
          status: 'ok',
          suggestion: {
            thresholdMinor: 200000,
            rate: 0.3,
            baselineRate: 0.1,
            n: 150,
            scope: 'cohort',
          },
        },
      })
    );
    render(<Page />);
    const el = await screen.findByText(/^fee\.suggestion:/);
    expect(el.textContent).toContain('"n":150');
    expect(el.textContent).toContain('"rate":"30%"');
  });

  it('the sharing switch starts off and saves the opt-in', async () => {
    api.apiGet.mockResolvedValue(overview());
    api.apiPut.mockResolvedValue({ data: { ciSharing: true } });
    render(<Page />);
    const sw = await screen.findByRole('switch', { name: 'sharing.title' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(api.apiPut).toHaveBeenCalledWith('/api/v1/stores/store-1/ci/sharing', {
        ciSharing: true,
      })
    );
  });
});
