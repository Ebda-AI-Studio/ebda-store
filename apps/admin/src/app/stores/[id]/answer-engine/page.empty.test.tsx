// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 's1' }) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@ebda/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  withNumerals: () => ({}),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/ErrorState', () => ({ ErrorState: () => null }));
vi.mock('../../../../hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, gate: null }),
}));
vi.mock('./_hooks/useAnswerEngineSummary', () => ({
  useAnswerEngineSummary: () => ({
    summary: { lastRunAt: null, engines: [], trend: [], prompts: [] },
    isLoading: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('./_hooks/useGscDashboard', () => ({
  useGscDashboard: () => ({
    gsc: { connected: false, hasData: false, trend: [], totals: null, topQueries: [] },
    isLoading: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('./_components/GscNotConnected', () => ({ GscNotConnected: () => null }));

import AnswerEnginePage from './page';

afterEach(cleanup);

describe('answer-engine page with no citation data (GS2)', () => {
  it('shows the empty sentence ONCE, not once per panel', () => {
    render(<AnswerEnginePage />);
    expect(screen.getAllByText('noData')).toHaveLength(1);
    expect(screen.getByTestId('citations-empty')).toBeTruthy();
  });
});
