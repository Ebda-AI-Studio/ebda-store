// @vitest-environment jsdom
/** The COD risk note and the courier line: what a merchant sees, and that nothing shows when there is nothing to say. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../../lib/api', () => api);

import { OrderCodRiskCard } from './OrderCodRiskCard';
import { CourierHint } from './CourierHint';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const hint = (over: object) => ({
  data: {
    enabled: true,
    applicable: true,
    hint: {
      band: 'insufficient',
      source: 'none',
      n: 0,
      rate: null,
      reasons: [],
      suggestions: [],
      ...over,
    },
  },
});

describe('OrderCodRiskCard', () => {
  it('"not enough data yet" shows no number, no reasons and no suggestion', async () => {
    api.apiGet.mockResolvedValue(hint({}));
    render(<OrderCodRiskCard storeId="s" orderId="o" />);
    expect(await screen.findByText('band.insufficient')).toBeTruthy();
    expect(screen.queryByText(/basedOn/)).toBeNull();
    expect(screen.queryByText(/suggest\./)).toBeNull();
    expect(screen.getByText('advisory')).toBeTruthy();
  });

  it('an elevated band shows its n, the reason and the suggestions', async () => {
    api.apiGet.mockResolvedValue(
      hint({
        band: 'elevated',
        source: 'cohort',
        n: 412,
        reasons: ['area'],
        suggestions: ['confirm_by_phone', 'ask_instapay_deposit'],
      })
    );
    render(<OrderCodRiskCard storeId="s" orderId="o" />);
    expect(await screen.findByText('band.elevated')).toBeTruthy();
    expect(screen.getByText('basedOn:{"n":412}')).toBeTruthy();
    expect(screen.getByText('reason.area')).toBeTruthy();
    expect(screen.getByText('suggest.ask_instapay_deposit')).toBeTruthy();
  });

  it.each([
    [{ data: { enabled: false } }],
    [{ data: { enabled: true, applicable: false } }],
    [{ data: undefined }],
  ])('renders nothing when off, not COD, or the call failed', async res => {
    api.apiGet.mockResolvedValue(res);
    const { container } = render(<OrderCodRiskCard storeId="s" orderId="o" />);
    await waitFor(() => expect(api.apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('CourierHint', () => {
  it('names the leader only when two carriers could be compared', async () => {
    api.apiGet.mockResolvedValue({
      data: {
        enabled: true,
        suggested: 'bosta',
        ranked: [{ carrier: 'bosta', status: 'ok', deliveredRate: 0.95, n: 300 }],
      },
    });
    render(
      <CourierHint
        storeId="s"
        orderId="o"
        carriers={['bosta', 'aramex']}
        names={{ bosta: 'Bosta' }}
      />
    );
    expect(await screen.findByText('best:{"carrier":"Bosta","rate":"95%","n":300}')).toBeTruthy();
  });

  it('shows nothing without a suggestion', async () => {
    api.apiGet.mockResolvedValue({ data: { enabled: true, suggested: null, ranked: [] } });
    const { container } = render(
      <CourierHint storeId="s" orderId="o" carriers={['bosta']} names={{}} />
    );
    await waitFor(() => expect(api.apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
