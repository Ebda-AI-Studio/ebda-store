// @vitest-environment jsdom
/** Super-admin CI page: findings show their n and stores; accept/dismiss call the API; a gate can be closed by a person. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../lib/api', () => api);
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../components/RequireSuperAdmin', () => ({
  RequireSuperAdmin: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import Page from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const insight = {
  id: 'i1',
  metric: 'return_rate',
  cohort: 'aramex|EG-G',
  finding: 'Returns are elevated for aramex in EG-G',
  findingAr: 'ar',
  evidence: { n: 300, stores: 6, rate: 0.2, baselineRate: 0.1, asOf: '2026-11-09' },
  model: 'rules-v1',
  status: 'new',
  asOf: '2026-11-09',
};

function mockGets() {
  api.apiGet.mockImplementation(async (url: string) =>
    url.includes('/insights')
      ? { data: { insights: [insight] } }
      : { data: { gates: [{ feature: 'cod_risk', enabled: true, reason: null, at: null }] } }
  );
  api.apiPut.mockResolvedValue({ data: {} });
}

describe('CI insights page', () => {
  it('lists a finding with its n and stores, and accept sends the decision', async () => {
    mockGets();
    render(<Page />);
    expect(await screen.findByText(insight.finding)).toBeTruthy();
    expect(screen.getByText('evidence:{"n":300,"stores":6,"date":"2026-11-09"}')).toBeTruthy();
    fireEvent.click(screen.getByText('accept'));
    await waitFor(() =>
      expect(api.apiPut).toHaveBeenCalledWith('/api/v1/admin/ci/insights/i1', {
        status: 'accepted',
      })
    );
  });

  it('a person closes a hint switch', async () => {
    mockGets();
    render(<Page />);
    fireEvent.click(await screen.findByText('gates.close'));
    await waitFor(() =>
      expect(api.apiPut).toHaveBeenCalledWith('/api/v1/admin/ci/gates/cod_risk', { enabled: false })
    );
  });
});
