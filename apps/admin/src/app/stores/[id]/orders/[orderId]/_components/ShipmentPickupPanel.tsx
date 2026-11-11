'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../../lib/api';
import { ConfirmActionModal } from '../../../../../../components/ConfirmActionModal';

import { Button } from '@/components/ui/Button';
interface PickupRow {
  id: string;
  status: 'requesting' | 'requested' | 'failed' | 'cancelled';
  pickupDate: string;
  windowFrom: string | null;
  windowTo: string | null;
  windowLabel: string | null;
  carrierReference: string | null;
  carrierPickupId: string | null;
  carrierTimeSlot: string | null;
  error: string | null;
  address: { line1?: string; city?: string; area?: string };
  createdAt: string;
}

interface PickupState {
  carrier: string;
  mode: 'request' | 'automatic' | 'none';
  window: 'none' | 'times' | 'carrier_slots';
  cancellable: boolean;
  canRequest: boolean;
  shipmentStatus: string;
  automaticWarning: string | null;
  minDate: string;
  maxDate: string;
  active: PickupRow | null;
  pickups: PickupRow[];
}

interface SlotOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pk-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const STATUS_STYLE: Record<PickupRow['status'], string> = {
  requesting: 'bg-muted text-muted-foreground',
  requested: 'bg-success/10 text-success-ink',
  failed: 'bg-destructive/10 text-destructive-ink',
  cancelled: 'bg-muted text-muted-foreground',
};

/**
 * Courier pickup for a booked shipment (PROVIDERS-18): ask Bosta / Aramex / Mylerz to collect
 * the parcel from the store's pickup location on a chosen date (Aramex: a time window; Mylerz:
 * one of its slots; Bosta assigns the slot itself), see the request's state and cancel it where
 * the carrier allows. ShipBlu asks for its pickup at booking, so its state is shown instead.
 */
export function ShipmentPickupPanel({
  storeId,
  shipmentId,
  carrierName,
}: {
  storeId: string;
  shipmentId: string;
  carrierName: string;
}) {
  const t = useT('orders.detail.shipment.pickup');
  const { success: toastSuccess, error: toastError } = useToast();
  const base = `/api/v1/stores/${storeId}/shipments/${shipmentId}/pickup`;

  const [state, setState] = useState<PickupState | null>(null);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('16:00');
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slotId, setSlotId] = useState('');
  // One key per dialog: a double click or a network retry is the SAME pickup request.
  const [requestKey, setRequestKey] = useState(newKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await apiGet<PickupState>(base);
    if (data) {
      setState(data);
      setDate(prev => prev || data.minDate);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open || state?.window !== 'carrier_slots' || slots !== null) return;
    void apiGet<{ windows: SlotOption[] }>(`${base}/windows`).then(({ data, error }) => {
      if (error) {
        setSlots([]);
        toastError(t('errorTitle'), error.message || t('slotsFailed'));
        return;
      }
      const list = data?.windows ?? [];
      setSlots(list);
      setSlotId(list.find(s => s.isDefault)?.id ?? list[0]?.id ?? '');
    });
  }, [open, state?.window, slots, base, t, toastError]);

  if (!state || (state.mode !== 'request' && state.mode !== 'automatic')) return null;
  const history = Array.isArray(state.pickups) ? state.pickups : [];

  if (state.mode === 'automatic') {
    return (
      <div className="rounded-lg border border-border p-3" data-testid="pickup-automatic">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-sm text-muted-foreground mt-1">
          {state.automaticWarning
            ? t('automaticFailed', { carrier: carrierName })
            : t('automatic', { carrier: carrierName })}
        </p>
      </div>
    );
  }

  const submit = async () => {
    setBusy('request');
    try {
      const slot = slots?.find(s => s.id === slotId);
      const { error } = await apiPost(base, {
        date,
        idempotencyKey: requestKey,
        ...(state.window === 'times' ? { window: { from, to } } : {}),
        ...(state.window === 'carrier_slots' && slot
          ? { windowId: slot.id, windowLabel: slot.label }
          : {}),
      });
      if (error) {
        toastError(t('errorTitle'), error.message || t('failed'));
      } else {
        toastSuccess(t('requested'), '');
        setOpen(false);
        setRequestKey(newKey());
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (pickupId: string) => {
    setBusy('cancel');
    try {
      const { error } = await apiPost(`${base}/${pickupId}/cancel`, {});
      if (error) toastError(t('errorTitle'), error.message || t('failed'));
      else toastSuccess(t('cancelled'), '');
      setConfirmCancel(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const when = (p: PickupRow) =>
    [
      p.pickupDate,
      p.windowFrom && p.windowTo ? `${p.windowFrom}–${p.windowTo}` : null,
      p.windowLabel,
      p.carrierTimeSlot ? t('carrierSlot', { slot: p.carrierTimeSlot }) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const windowValid =
    state.window !== 'times' ||
    (/^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to) && from < to);

  return (
    <div className="rounded-lg border border-border p-3 space-y-3" data-testid="pickup-panel">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        {state.canRequest && !open && (
          <Button
            type="button"
            onClick={() => setOpen(true)}
            disabled={busy !== null}
            variant="secondary"
            size="sm"
          >
            {t('request')}
          </Button>
        )}
      </div>

      {!state.active && !state.canRequest && history.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('notAvailable')}</p>
      )}

      {open && (
        <div className="space-y-3 rounded-lg bg-muted/40 p-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('date')}</span>
            <input
              type="date"
              value={date}
              min={state.minDate}
              max={state.maxDate}
              onChange={e => setDate(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm"
            />
          </label>
          {state.window === 'times' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-muted-foreground">{t('from')}</span>
                <input
                  type="time"
                  value={from}
                  onChange={e => setFrom(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted-foreground">{t('to')}</span>
                <input
                  type="time"
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm"
                />
              </label>
            </div>
          )}
          {state.window === 'carrier_slots' && (
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('slot')}</span>
              <select
                value={slotId}
                onChange={e => setSlotId(e.target.value)}
                disabled={slots === null}
                className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm"
              >
                {slots === null && <option value="">{t('slotsLoading')}</option>}
                {slots?.length === 0 && <option value="">{t('slotDefault')}</option>}
                {slots?.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state.window === 'none' && (
            <p className="text-xs text-muted-foreground">
              {t('carrierAssigns', { carrier: carrierName })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('addressHint')}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy !== null || !date || !windowValid}
              variant="default"
            >
              {t('submit')}
            </Button>
            <Button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy !== null}
              variant="secondary"
            >
              {t('close')}
            </Button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <ul className="space-y-2">
          {history.map(p => (
            <li key={p.id} className="text-sm" data-testid={`pickup-${p.status}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLE[p.status]}`}>
                  {t(`statuses.${p.status}`)}
                </span>
                <span className="text-foreground">{when(p)}</span>
                {p.carrierReference && (
                  <span className="text-muted-foreground font-mono">
                    {t('reference', { ref: p.carrierReference })}
                  </span>
                )}
              </div>
              {(p.address.line1 || p.address.city) && (
                <p className="text-xs text-muted-foreground">
                  {[p.address.line1, p.address.area, p.address.city].filter(Boolean).join(', ')}
                </p>
              )}
              {p.error && <p className="text-xs text-destructive-ink">{p.error}</p>}
              {p.status === 'requested' &&
                (state.cancellable ? (
                  <Button
                    type="button"
                    onClick={() => setConfirmCancel(p.id)}
                    disabled={busy !== null}
                    variant="outline"
                    size="sm"
                    className="mt-1 text-destructive-ink"
                  >
                    {t('cancel')}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('cancelInPortal', { carrier: carrierName })}
                  </p>
                ))}
            </li>
          ))}
        </ul>
      )}

      <ConfirmActionModal
        open={confirmCancel !== null}
        title={t('confirmCancelTitle')}
        description={t('confirmCancelDescription')}
        confirmLabel={t('cancel')}
        cancelLabel={t('keep')}
        variant="destructive"
        isLoading={busy === 'cancel'}
        onConfirm={() => confirmCancel && void cancel(confirmCancel)}
        onClose={() => setConfirmCancel(null)}
      />
    </div>
  );
}
