// @vitest-environment jsdom
/**
 * PROVIDERS-18 courier pickup panel (every data has a UI): what the merchant sees and sends for
 * each carrier's pickup shape, the request history and cancellation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../../lib/api', () => api);
vi.mock('../../../../../../components/ConfirmActionModal', () => ({
  ConfirmActionModal: ({
    open,
    title,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <button onClick={onConfirm}>confirm-{title}</button>
      </div>
    ) : null,
}));

import { ToastProvider } from '@force/ui';
import { ShipmentPickupPanel } from './ShipmentPickupPanel';

const BASE = '/api/v1/stores/s1/shipments/sh-1/pickup';
const state = (over: Record<string, unknown> = {}) => ({
  carrier: 'bosta',
  mode: 'request',
  window: 'none',
  cancellable: true,
  canRequest: true,
  shipmentStatus: 'created',
  automaticWarning: null,
  minDate: '2026-10-09',
  maxDate: '2026-10-23',
  active: null,
  pickups: [],
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'pu-1',
  status: 'requested',
  pickupDate: '2026-10-10',
  windowFrom: null,
  windowTo: null,
  windowLabel: null,
  carrierReference: '7878001',
  carrierPickupId: '070000002501',
  carrierTimeSlot: '10:00 to 13:00',
  error: null,
  address: { line1: '12 Tahrir St', city: 'Cairo' },
  createdAt: '2026-10-08T10:00:00.000Z',
  ...over,
});

const panel = (s: Record<string, unknown>, slots?: unknown[]) => {
  api.apiGet.mockImplementation(async (url: string) =>
    url.endsWith('/windows') ? { data: { windows: slots ?? [] } } : { data: s }
  );
  return render(
    <ToastProvider>
      <ShipmentPickupPanel storeId="s1" shipmentId="sh-1" carrierName="Bosta" />
    </ToastProvider>
  );
};

beforeEach(() => {
  api.apiGet.mockReset();
  api.apiPost.mockReset().mockResolvedValue({ data: {}, error: null });
});
afterEach(cleanup);

describe('ShipmentPickupPanel', () => {
  it('Bosta: date only (the carrier assigns the slot); sends date + one idempotency key', async () => {
    panel(state());
    fireEvent.click(await screen.findByText('request'));
    expect(screen.getByText(/carrierAssigns/)).toBeTruthy();
    expect(screen.queryByText('from')).toBeNull();
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = api.apiPost.mock.calls[0];
    expect(url).toBe(BASE);
    expect(body).toEqual({ date: '2026-10-09', idempotencyKey: expect.any(String) });
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('Aramex: sends the from/to window', async () => {
    panel(state({ carrier: 'aramex', window: 'times' }));
    fireEvent.click(await screen.findByText('request'));
    fireEvent.change(screen.getByLabelText('from'), { target: { value: '11:00' } });
    fireEvent.change(screen.getByLabelText('to'), { target: { value: '15:30' } });
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith(
        BASE,
        expect.objectContaining({ window: { from: '11:00', to: '15:30' } })
      )
    );
  });

  it('Mylerz: lists the carrier slots and sends the chosen one', async () => {
    panel(state({ carrier: 'mylerz', window: 'carrier_slots', cancellable: false }), [
      { id: '1', label: '09:00 - 13:00', isDefault: true },
      { id: '2', label: '13:00 - 17:00' },
    ]);
    fireEvent.click(await screen.findByText('request'));
    const select = (await screen.findByLabelText('slot')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('1'));
    fireEvent.change(select, { target: { value: '2' } });
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith(
        BASE,
        expect.objectContaining({ windowId: '2', windowLabel: '13:00 - 17:00' })
      )
    );
  });

  it('shows the request history with the slot and reference, and cancels a requested pickup', async () => {
    panel(state({ canRequest: false, active: row(), pickups: [row()] }));
    expect(await screen.findByTestId('pickup-requested')).toBeTruthy();
    expect(screen.getByText(/10:00 to 13:00/)).toBeTruthy();
    expect(screen.getByText(/7878001/)).toBeTruthy();
    expect(screen.queryByText('request')).toBeNull();
    fireEvent.click(screen.getByText('cancel'));
    fireEvent.click(await screen.findByText('confirm-confirmCancelTitle'));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith(`${BASE}/pu-1/cancel`, {}));
  });

  it('a carrier without API cancel says where to cancel; a failed request shows its note', async () => {
    panel(
      state({
        carrier: 'mylerz',
        cancellable: false,
        canRequest: true,
        pickups: [row(), row({ id: 'pu-0', status: 'failed', error: 'may have been booked' })],
      })
    );
    expect(await screen.findByText(/cancelInPortal/)).toBeTruthy();
    expect(screen.getByText('may have been booked')).toBeTruthy();
    expect(screen.queryByText('cancel')).toBeNull();
  });

  it('ShipBlu: shows the automatic pickup state (or its refusal), no request button', async () => {
    panel(state({ carrier: 'shipblu', mode: 'automatic', canRequest: false }));
    expect(await screen.findByTestId('pickup-automatic')).toBeTruthy();
    expect(screen.getByText(/^automatic/)).toBeTruthy();
    expect(screen.queryByText('request')).toBeNull();
    cleanup();
    panel(state({ carrier: 'shipblu', mode: 'automatic', automaticWarning: 'refused' }));
    expect(await screen.findByText(/automaticFailed/)).toBeTruthy();
  });

  it('renders nothing for a carrier without pickups', async () => {
    const { container } = panel(state({ mode: 'none' }));
    await waitFor(() => expect(api.apiGet).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="pickup-panel"]')).toBeNull();
  });
});
