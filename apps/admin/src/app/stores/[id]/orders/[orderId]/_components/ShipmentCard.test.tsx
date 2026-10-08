// @vitest-environment jsdom
/**
 * SP7 order-page shipping card (every data has a UI): what a merchant sees and can do for
 * each state of an order's shipment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    {
      has: () => true,
    }
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
        <span>{title}</span>
        <button onClick={onConfirm}>confirm-{title}</button>
      </div>
    ) : null,
}));

import { ToastProvider } from '@force/ui';
import { ShipmentCard } from './ShipmentCard';

const CARRIERS = [
  { code: 'bosta', name: 'Bosta', capabilities: { label: true, polling: true, cod: true } },
  { code: 'manual', name: 'Manual', capabilities: { label: false, polling: false, cod: true } },
];
const shipment = (over: Record<string, unknown> = {}) => ({
  id: 'sh-1',
  carrier: 'bosta',
  carrierName: null,
  trackingNumber: 'BST00000001',
  trackingUrl: null,
  status: 'in_transit',
  codAmount: 12345,
  error: null,
  createAttempts: 1,
  statusHistory: [
    { status: 'created', timestamp: '2026-10-05T08:00:00.000Z' },
    { status: 'in_transit', timestamp: '2026-10-05T10:00:00.000Z', location: 'Cairo hub' },
  ],
  ...over,
});
const card = (data: Record<string, unknown>) => {
  api.apiGet.mockResolvedValue({
    data: {
      shipment: null,
      carriers: CARRIERS,
      codAmount: 0,
      canBook: true,
      orderStatus: 'confirmed',
      ...data,
    },
  });
  return render(
    <ToastProvider>
      <ShipmentCard storeId="s1" orderId="o1" onChanged={() => undefined} />
    </ToastProvider>
  );
};

beforeEach(() => {
  api.apiGet.mockReset();
  api.apiPost.mockReset().mockResolvedValue({ data: {}, error: null });
});
afterEach(cleanup);

describe('ShipmentCard', () => {
  it('shows the tracking number, status, COD and the timeline of a booked shipment', async () => {
    card({ shipment: shipment() });
    expect(await screen.findByText('BST00000001')).toBeTruthy();
    expect(screen.getByText(/cod:/)).toBeTruthy();
    expect(screen.getByText('timeline')).toBeTruthy();
    expect(screen.getByText(/Cairo hub/)).toBeTruthy();
    expect(screen.getByText('printLabel')).toBeTruthy();
    expect(screen.getByText('refresh')).toBeTruthy();
    expect(screen.getByText('cancel')).toBeTruthy();
  });

  it('offers no label button for a carrier without one, and no cancel once delivered', async () => {
    card({
      shipment: shipment({ carrier: 'manual', carrierName: 'Sprint', status: 'delivered' }),
    });
    expect(await screen.findByText('Sprint')).toBeTruthy();
    expect(screen.queryByText('printLabel')).toBeNull();
    expect(screen.queryByText('cancel')).toBeNull();
  });

  it('creates a shipment with the chosen carrier', async () => {
    card({ codAmount: 5000 });
    fireEvent.click(await screen.findByText('create'));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/orders/o1/ship', {
        carrier: 'bosta',
      })
    );
  });

  it('sends the courier name and tracking number for the manual carrier', async () => {
    card({});
    const select = (await screen.findByLabelText('carrier')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'manual' } });
    const create = screen.getByText('create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('manualName'), { target: { value: 'Sprint' } });
    fireEvent.change(screen.getByLabelText('manualTracking'), { target: { value: 'SPR-1' } });
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/orders/o1/ship', {
        carrier: 'manual',
        manual: { carrierName: 'Sprint', trackingNumber: 'SPR-1' },
      })
    );
  });

  it('a failed booking shows why and offers a retry; the order is not blocked', async () => {
    card({
      shipment: shipment({
        status: 'creation_failed',
        error: 'bosta.create: carrier HTTP 503',
        trackingNumber: null,
      }),
    });
    expect(await screen.findByText('failedTitle')).toBeTruthy();
    expect(screen.getByText('bosta.create: carrier HTTP 503')).toBeTruthy();
    expect(screen.getByText('retry')).toBeTruthy();
  });

  it('an InstaPay order awaiting confirmation cannot be shipped: no create button, a reason', async () => {
    card({ canBook: false, orderStatus: 'awaiting_payment_confirmation' });
    expect(await screen.findByText('blocked.instapay')).toBeTruthy();
    expect(screen.queryByText('create')).toBeNull();
  });

  it('cancelling a parcel the carrier will not cancel offers to stop tracking it anyway', async () => {
    card({ shipment: shipment() });
    fireEvent.click(await screen.findByText('cancel'));
    api.apiPost.mockResolvedValueOnce({
      data: null,
      error: { code: 'SHIPMENT_NOT_CANCELLABLE', message: 'no' },
    });
    fireEvent.click(screen.getByText('confirm-confirmCancelTitle'));
    expect(await screen.findByText('forceCancelTitle')).toBeTruthy();
    fireEvent.click(screen.getByText('confirm-forceCancelTitle'));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenLastCalledWith('/api/v1/stores/s1/orders/o1/ship/cancel', {
        force: true,
      })
    );
  });

  describe('manual shipment moved to "returned" (return to origin)', () => {
    const manual = () =>
      shipment({ carrier: 'manual', carrierName: 'Sprint', trackingNumber: 'SPR-1' });
    const pickReturned = async () => {
      const select = (await screen.findByLabelText('moveTo')) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'returned' } });
    };

    it('asks first (nothing is sent on pick) and restocks by default', async () => {
      card({ shipment: manual() });
      await pickReturned();
      expect(await screen.findByText('confirmReturnDescription')).toBeTruthy();
      expect((screen.getByLabelText('restockLabel') as HTMLInputElement).checked).toBe(true);
      expect(api.apiPost).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('confirmReturn'));
      await waitFor(() =>
        expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/shipments/sh-1/status', {
          status: 'returned',
          restock: true,
        })
      );
    });

    it('sends restock:false when the merchant unticks the box', async () => {
      card({ shipment: manual() });
      await pickReturned();
      fireEvent.click(await screen.findByLabelText('restockLabel'));
      fireEvent.click(screen.getByText('confirmReturn'));
      await waitFor(() =>
        expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/shipments/sh-1/status', {
          status: 'returned',
          restock: false,
        })
      );
    });

    it('other manual statuses are sent straight away, without a restock flag', async () => {
      card({ shipment: manual() });
      const select = (await screen.findByLabelText('moveTo')) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'in_transit' } });
      await waitFor(() =>
        expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/shipments/sh-1/status', {
          status: 'in_transit',
        })
      );
    });
  });
});

export type { ReactNode };
