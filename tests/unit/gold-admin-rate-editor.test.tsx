// @vitest-environment jsdom
/**
 * The rates page controls (B5 Task 13): a rate typed in EGP travels as integer piastres; a jump over the gate
 * (409 GOLD_RATE_CONFIRM_REQUIRED) opens the dialog and nothing is applied until the merchant confirms, which
 * resends the SAME rates with confirm:true; garbage input never reaches the network; a pending feed rate is
 * decided through its own endpoint; the settings card sends the typed premium and hours as bps and minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

import { RateEditor } from '../../apps/admin/src/app/stores/[id]/gold-rates/_components/RateEditor';
import { PendingRateBanner } from '../../apps/admin/src/app/stores/[id]/gold-rates/_components/PendingRateBanner';
import { GoldSettingsCard } from '../../apps/admin/src/app/stores/[id]/gold-rates/_components/GoldSettingsCard';

const RATES = [
  { karat: 24 as const, ratePerGram: 480000, appliedAt: 'x', ageMinutes: 5, stale: false },
  { karat: 21 as const, ratePerGram: 420000, appliedAt: 'x', ageMinutes: 5, stale: false },
  { karat: 18 as const, ratePerGram: 360000, appliedAt: 'x', ageMinutes: 5, stale: false },
];
const inputs = () => screen.getAllByRole('textbox') as HTMLInputElement[];

beforeEach(() => {
  apiPut.mockReset();
  apiPost.mockReset();
});
afterEach(cleanup);

describe('RateEditor', () => {
  it('sends EGP typed as integer piastres', async () => {
    apiPut.mockResolvedValue({ data: {}, error: null });
    const saved = vi.fn();
    render(<RateEditor storeId="s" rates={RATES} feedEnabled={false} canEdit onSaved={saved} />);
    fireEvent.change(inputs()[1]!, { target: { value: '4,150.55'.replace(',', '') } });
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    const [url, body] = apiPut.mock.calls[0] as [string, { rates: unknown[]; confirm?: boolean }];
    expect(url).toBe('/api/v1/stores/s/gold-rates');
    expect(body.rates).toEqual([
      { karat: 24, ratePerGram: 480000 },
      { karat: 21, ratePerGram: 415055 },
      { karat: 18, ratePerGram: 360000 },
    ]);
    expect(body.confirm).toBeUndefined();
    expect(saved).toHaveBeenCalled();
  });

  it('never sends a rate with a third decimal or letters', async () => {
    render(<RateEditor storeId="s" rates={RATES} feedEnabled={false} canEdit onSaved={() => {}} />);
    fireEvent.change(inputs()[0]!, { target: { value: '4800.999' } });
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(apiPut).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('invalid');
  });

  it('opens the confirm dialog on a jump and resends with confirm:true only after the merchant agrees', async () => {
    apiPut
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'GOLD_RATE_CONFIRM_REQUIRED',
          status: 409,
          message: 'x',
          details: { items: [{ karat: 21, jumpBps: 2500, coherenceBps: null }] },
        },
      })
      .mockResolvedValueOnce({ data: {}, error: null });
    const saved = vi.fn();
    render(<RateEditor storeId="s" rates={RATES} feedEnabled={false} canEdit onSaved={saved} />);
    fireEvent.change(inputs()[1]!, { target: { value: '5250' } });
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
    expect(apiPut).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByText('confirmApply'));
    });
    expect(apiPut).toHaveBeenCalledTimes(2);
    expect((apiPut.mock.calls[1] as [string, { confirm?: boolean }])[1].confirm).toBe(true);
    await waitFor(() => expect(saved).toHaveBeenCalled());
  });

  it('"back" closes the dialog and writes nothing more', async () => {
    apiPut.mockResolvedValue({
      data: null,
      error: { code: 'GOLD_RATE_CONFIRM_REQUIRED', status: 409, message: 'x', details: {} },
    });
    render(<RateEditor storeId="s" rates={RATES} feedEnabled={false} canEdit onSaved={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    fireEvent.click(screen.getByText('back'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  it('names the rate provider only next to the automatic rate (licence attribution)', () => {
    const { rerender } = render(
      <RateEditor storeId="s" rates={RATES} feedEnabled canEdit onSaved={() => {}} />
    );
    expect(screen.getByText('Rates By Exchange Rate API')).toBeTruthy();
    rerender(
      <RateEditor storeId="s" rates={RATES} feedEnabled={false} canEdit onSaved={() => {}} />
    );
    expect(screen.queryByText('Rates By Exchange Rate API')).toBeNull();
  });
});

describe('PendingRateBanner', () => {
  const pending = [
    {
      id: 'r1',
      karat: 21 as const,
      ratePerGram: 520000,
      source: 'feed',
      jumpBps: 2400,
      createdAt: 'x',
    },
  ];
  it('renders nothing without pending rates', () => {
    const { container } = render(
      <PendingRateBanner storeId="s" pending={[]} canEdit onDecided={() => {}} />
    );
    expect(container.innerHTML).toBe('');
  });
  it('confirms and rejects through the decision endpoint', async () => {
    apiPost.mockResolvedValue({ data: {}, error: null });
    const decided = vi.fn();
    render(<PendingRateBanner storeId="s" pending={pending} canEdit onDecided={decided} />);
    await act(async () => {
      fireEvent.click(screen.getByText('confirm'));
    });
    expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s/gold-rates/r1/decision', {
      decision: 'confirm',
    });
    await act(async () => {
      fireEvent.click(screen.getByText('reject'));
    });
    expect(apiPost).toHaveBeenLastCalledWith('/api/v1/stores/s/gold-rates/r1/decision', {
      decision: 'reject',
    });
    expect(decided).toHaveBeenCalledTimes(2);
  });
});

describe('GoldSettingsCard', () => {
  const settings = {
    enabled: true,
    feedEnabled: true,
    feedPremiumBps: 150,
    maxAgeMinutes: 1560,
    jumpConfirmBps: 500,
    roundingStep: 100 as const,
    showBreakdown: false,
  };
  it('shows stored values in human units and sends bps and minutes', async () => {
    apiPut.mockResolvedValue({ data: {}, error: null });
    render(<GoldSettingsCard storeId="s" settings={settings} canEdit onSaved={() => {}} />);
    expect(screen.getByDisplayValue('1.5')).toBeTruthy();
    expect(screen.getByDisplayValue('26')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(apiPut.mock.calls[0]).toEqual(['/api/v1/stores/s/gold-rates/settings', settings]);
  });
  it('refuses a premium or an expiry outside the allowed range before any request', async () => {
    render(<GoldSettingsCard storeId="s" settings={settings} canEdit onSaved={() => {}} />);
    fireEvent.change(screen.getByDisplayValue('1.5'), { target: { value: '11' } });
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(screen.getByRole('alert').textContent).toBe('badPremium');
    fireEvent.change(screen.getByDisplayValue('11'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByDisplayValue('26'), { target: { value: '27' } });
    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    expect(screen.getByRole('alert').textContent).toBe('badAge');
    expect(apiPut).not.toHaveBeenCalled();
  });
});
