// @vitest-environment jsdom
/**
 * GOLD-DISAGREE-MERCHANT-1: the disagreement banner shows both feed values and the gap and decides ONLY through
 * the existing paths: apply first = confirm each pending rate; apply second = manual PUT (confirm:true) then
 * reject the pending rows; keep current = reject each pending rate. Nothing is sent until a button is pressed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const apiPut = vi.fn();
const apiPost = vi.fn();
vi.mock('../../apps/admin/src/lib/api', () => ({
  apiPut: (...a: unknown[]) => apiPut(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiGet: vi.fn(),
}));
vi.mock('../../apps/admin/src/i18n/useT', () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}|${JSON.stringify(v)}` : k),
}));

import { DisagreementBanner } from '../../apps/admin/src/app/stores/[id]/gold-rates/_components/DisagreementBanner';

const RATES = [
  { karat: 24 as const, ratePerGram: 480000, appliedAt: 'x', ageMinutes: 5, stale: false },
  { karat: 21 as const, ratePerGram: 420000, appliedAt: 'x', ageMinutes: 5, stale: false },
  { karat: 18 as const, ratePerGram: 360000, appliedAt: 'x', ageMinutes: 5, stale: false },
];
const PENDING = [24, 21, 18].map((k, i) => ({
  id: `p${k}`,
  karat: k as 24 | 21 | 18,
  ratePerGram: 500000 - i,
  source: 'feed',
  jumpBps: 400,
  createdAt: 'x',
}));
const D = {
  diffBps: 313,
  primary24k: 500000,
  fallback24k: 515650,
  primaryRates: { 24: 500000, 21: 499999, 18: 499998 },
  fallbackRates: { 24: 515650, 21: 450194, 18: 386738 },
};
const mount = (onDecided = vi.fn()) => {
  render(
    <DisagreementBanner
      storeId="s"
      pending={PENDING}
      disagreement={D}
      rates={RATES}
      canEdit
      onDecided={onDecided}
    />
  );
  return onDecided;
};

beforeEach(() => {
  apiPut.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue({ data: {}, error: null });
  apiPut.mockResolvedValue({ data: {}, error: null });
});
afterEach(cleanup);

describe('DisagreementBanner', () => {
  it('sends nothing on render and shows the gap', () => {
    mount();
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalled();
    expect(screen.getByText(/"pct":"3.1"/)).toBeTruthy();
  });

  it('apply first source = confirm every pending rate through /decision', async () => {
    const done = mount();
    await act(async () => {
      fireEvent.click(screen.getByText('applyPrimary'));
    });
    expect(apiPost.mock.calls.map(c => [c[0], (c[1] as { decision: string }).decision])).toEqual(
      PENDING.map(p => [`/api/v1/stores/s/gold-rates/${p.id}/decision`, 'confirm'])
    );
    expect(apiPut).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it('apply second source = manual PUT of its rates with confirm:true, then the pending rows are rejected', async () => {
    const done = mount();
    await act(async () => {
      fireEvent.click(screen.getByText('applyFallback'));
    });
    expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s/gold-rates', {
      rates: [
        { karat: 24, ratePerGram: 515650 },
        { karat: 21, ratePerGram: 450194 },
        { karat: 18, ratePerGram: 386738 },
      ],
      confirm: true,
    });
    expect(
      apiPost.mock.calls.every(c => (c[1] as { decision: string }).decision === 'reject')
    ).toBe(true);
    expect(apiPost).toHaveBeenCalledTimes(3);
    expect(done).toHaveBeenCalled();
  });

  it('keep current = reject every pending rate, no rate write', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByText('keep'));
    });
    expect(apiPut).not.toHaveBeenCalled();
    expect(apiPost).toHaveBeenCalledTimes(3);
  });

  it('a failed write shows the error and does not report the decision done', async () => {
    apiPut.mockResolvedValue({ data: null, error: 'boom' });
    const done = mount();
    await act(async () => {
      fireEvent.click(screen.getByText('applyFallback'));
    });
    expect(screen.getByRole('alert').textContent).toBe('failed');
    expect(apiPost).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});
