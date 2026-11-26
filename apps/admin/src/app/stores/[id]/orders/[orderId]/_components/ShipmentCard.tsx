'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { apiGet, apiPost } from '../../../../../../lib/api';
import { ConfirmActionModal } from '../../../../../../components/ConfirmActionModal';
import { OrderStatusBadge } from '../../../../../../components/OrderStatusBadge';
import { CourierHint } from './CourierHint';
import { formatMoney } from './format';
import { ShipmentPickupPanel } from './ShipmentPickupPanel';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface HistoryEntry {
  status: string;
  timestamp: string;
  location?: string;
  description?: string;
}

interface ShipmentRow {
  id: string;
  carrier: string;
  carrierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  codAmount: number;
  error: string | null;
  createAttempts: number;
  statusHistory: HistoryEntry[];
}

interface CarrierOption {
  code: string;
  name: string;
  capabilities: { label: boolean; polling: boolean; cod: boolean | 'unconfirmed' };
}

interface ShipmentCardData {
  shipment: ShipmentRow | null;
  carriers: CarrierOption[];
  codAmount: number;
  canBook: boolean;
  orderStatus: string | null;
}

const MANUAL_STATUSES = [
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned',
];

interface ShipmentCardProps {
  storeId: string;
  orderId: string;
  /** Re-fetch the order after the shipment changes (the order status moves with it). */
  onChanged: () => void;
  /** Customer Intelligence is on for this store: show the courier suggestion under the picker. */
  courierHints?: boolean;
}

/**
 * The order page's shipping card: create a shipment (a carrier from the store's settings, or the
 * manual carrier), print its label, refresh and read its tracking timeline, move a manual
 * shipment along, and cancel. A booking that failed shows its reason and a Retry; an InstaPay
 * order waiting for confirmation shows why it cannot be shipped yet.
 */
export function ShipmentCard({ storeId, orderId, onChanged, courierHints }: ShipmentCardProps) {
  const t = useT('orders.detail.shipment');
  const tStatus = useT('shipping.carriers.shipments');
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();

  const [data, setData] = useState<ShipmentCardData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [carrier, setCarrier] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualTracking, setManualTracking] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [forceCancel, setForceCancel] = useState(false);
  // Manual shipment moved to "returned" (return to origin): ask whether the items go back in stock.
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [restock, setRestock] = useState(true);

  const base = `/api/v1/stores/${storeId}`;

  const load = useCallback(async () => {
    const { data: d } = await apiGet<ShipmentCardData>(`${base}/orders/${orderId}/shipment`);
    if (d) {
      setData(d);
      setCarrier(prev => prev || d.shipment?.carrier || d.carriers[0]?.code || 'manual');
    }
  }, [base, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return null;
  const { shipment, carriers, canBook, orderStatus } = data;
  const failed = shipment?.status === 'creation_failed';
  const active =
    !!shipment && !failed && shipment.status !== 'cancelled' && shipment.status !== 'creating';
  const current = carriers.find(c => c.code === shipment?.carrier);
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      numberingSystem: 'latn',
    });

  const run = async (
    key: string,
    fn: () => Promise<{ error?: { message?: string } | null }>,
    ok?: string
  ) => {
    setBusy(key);
    try {
      const { error } = await fn();
      if (error) toastError(t('errorTitle'), error.message || t('failed'));
      else {
        if (ok) toastSuccess(ok, '');
        await load();
        onChanged();
      }
    } catch {
      toastError(t('errorTitle'), t('failed'));
    } finally {
      setBusy(null);
    }
  };

  const create = (code: string) =>
    run(
      'create',
      () =>
        apiPost(`${base}/orders/${orderId}/ship`, {
          carrier: code,
          ...(code === 'manual'
            ? { manual: { carrierName: manualName.trim(), trackingNumber: manualTracking.trim() } }
            : {}),
        }),
      t('created')
    );

  const printLabel = async () => {
    if (!shipment) return;
    setBusy('label');
    try {
      const { data: res, error } = await apiGet<{ label: { url?: string; pdfBase64?: string } }>(
        `${base}/shipments/${shipment.id}/label`
      );
      if (error || !res) {
        toastError(t('errorTitle'), error?.message || t('failed'));
        return;
      }
      if (res.label.url) {
        window.open(res.label.url, '_blank', 'noopener');
      } else if (res.label.pdfBase64) {
        const bytes = Uint8Array.from(atob(res.label.pdfBase64), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        window.open(url, '_blank', 'noopener');
      }
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (force: boolean) => {
    setBusy('cancel');
    try {
      const { error } = await apiPost(`${base}/orders/${orderId}/ship/cancel`, { force });
      if (error) {
        // the carrier already has the parcel: offer to stop tracking it here anyway
        if (
          ['SHIPMENT_NOT_CANCELLABLE', 'CARRIER_CANCEL_FAILED'].includes(
            (error as { code?: string }).code ?? ''
          )
        ) {
          setConfirmCancel(false);
          setForceCancel(true);
        } else toastError(t('errorTitle'), error.message || t('failed'));
      } else {
        setConfirmCancel(false);
        setForceCancel(false);
        toastSuccess(t('cancelled'), '');
        await load();
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  };

  const blockedReason =
    orderStatus === 'awaiting_payment_confirmation'
      ? t('blocked.instapay')
      : !canBook
        ? t('blocked.status')
        : null;

  return (
    <section
      className="rounded-lg border border-border bg-card p-5"
      aria-labelledby="shipment-card-title"
    >
      <h2
        id="shipment-card-title"
        className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4"
      >
        {t('title')}
      </h2>

      {active && shipment && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-foreground">
                {shipment.carrier === 'manual'
                  ? shipment.carrierName
                  : (current?.name ?? shipment.carrier)}
              </p>
              <p className="text-sm text-muted-foreground font-mono">
                {shipment.trackingUrl ? (
                  <a
                    href={shipment.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {shipment.trackingNumber}
                  </a>
                ) : (
                  shipment.trackingNumber
                )}
              </p>
            </div>
            <OrderStatusBadge status={shipment.status} family="shipment" />
          </div>

          {shipment.codAmount > 0 && (
            <p className="text-sm text-foreground">
              {t('cod', { amount: formatMoney(shipment.codAmount) })}
            </p>
          )}
          {shipment.error && <p className="text-sm text-destructive-ink">{shipment.error}</p>}

          <div className="flex flex-wrap gap-2">
            {current?.capabilities.label && (
              <Button
                type="button"
                onClick={printLabel}
                disabled={busy !== null}
                variant="secondary"
                size="sm"
              >
                {t('printLabel')}
              </Button>
            )}
            {current?.capabilities.polling && (
              <Button
                type="button"
                onClick={() =>
                  run('track', () => apiPost(`${base}/shipments/${shipment.id}/track`))
                }
                disabled={busy !== null}
                variant="secondary"
                size="sm"
              >
                {t('refresh')}
              </Button>
            )}
            {!['delivered', 'returned'].includes(shipment.status) && (
              <Button
                type="button"
                onClick={() => setConfirmCancel(true)}
                disabled={busy !== null}
                variant="outline"
                size="sm"
                className="text-destructive-ink"
              >
                {t('cancel')}
              </Button>
            )}
          </div>

          {shipment.carrier === 'manual' &&
            !['delivered', 'returned'].includes(shipment.status) && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t('moveTo')}</span>
                <select
                  defaultValue=""
                  disabled={busy !== null}
                  onChange={e => {
                    const status = e.target.value;
                    if (status === 'returned') {
                      // Cancels the order and frees the stock: confirm first.
                      e.target.value = '';
                      setRestock(true);
                      setConfirmReturn(true);
                    } else if (status) {
                      void run('status', () =>
                        apiPost(`${base}/shipments/${shipment.id}/status`, { status })
                      );
                    }
                  }}
                  className={FIELD_CLASSES}
                >
                  <option value="">{t('chooseStatus')}</option>
                  {MANUAL_STATUSES.map(s => (
                    <option key={s} value={s}>
                      {tStatus(`statuses.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}

          {shipment.carrier !== 'manual' && (
            <ShipmentPickupPanel
              storeId={storeId}
              shipmentId={shipment.id}
              carrierName={current?.name ?? shipment.carrier}
            />
          )}

          <div>
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-2">
              {t('timeline')}
            </h3>
            {shipment.statusHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('timelineEmpty')}</p>
            ) : (
              <ol className="space-y-2 border-s border-border ps-4">
                {[...shipment.statusHistory].reverse().map((h, i) => (
                  <li key={`${h.timestamp}-${h.status}-${i}`} className="text-sm">
                    <span className="font-medium text-foreground">
                      {tStatus(`statuses.${h.status}`)}
                    </span>
                    <span className="text-muted-foreground"> · {fmtTime(h.timestamp)}</span>
                    {(h.location || h.description) && (
                      <p className="text-xs text-muted-foreground">
                        {[h.location, h.description].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      {!active && (
        <div className="space-y-3">
          {failed && shipment && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm font-medium text-destructive-ink">{t('failedTitle')}</p>
              <p className="text-sm text-foreground mt-1">{shipment.error}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('failedHint', { attempts: shipment.createAttempts })}
              </p>
            </div>
          )}
          {shipment?.status === 'creating' && (
            <p className="text-sm text-muted-foreground">{t('creating')}</p>
          )}
          {shipment?.status === 'cancelled' && (
            <p className="text-sm text-muted-foreground">{t('wasCancelled')}</p>
          )}

          {blockedReason ? (
            <p className="text-sm text-muted-foreground">{blockedReason}</p>
          ) : shipment?.status === 'creating' ? null : (
            <>
              {data.codAmount > 0 && (
                <p className="text-sm text-foreground">
                  {t('codWillCollect', { amount: formatMoney(data.codAmount) })}
                </p>
              )}
              <label className="block text-sm">
                <span className="text-muted-foreground">{t('carrier')}</span>
                <select
                  value={carrier}
                  onChange={e => setCarrier(e.target.value)}
                  className={`${FIELD_CLASSES} mt-1`}
                >
                  {carriers.map(c => (
                    <option key={c.code} value={c.code}>
                      {c.code === 'manual' ? t('manualOption') : c.name}
                    </option>
                  ))}
                </select>
              </label>
              {courierHints && (
                <CourierHint
                  storeId={storeId}
                  orderId={orderId}
                  carriers={carriers.filter(c => c.code !== 'manual').map(c => c.code)}
                  names={Object.fromEntries(carriers.map(c => [c.code, c.name]))}
                />
              )}
              {carrier === 'manual' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={manualName}
                    onChange={e => setManualName(e.target.value)}
                    placeholder={t('manualName')}
                    aria-label={t('manualName')}
                    className={FIELD_CLASSES}
                  />
                  <input
                    type="text"
                    value={manualTracking}
                    onChange={e => setManualTracking(e.target.value)}
                    placeholder={t('manualTracking')}
                    aria-label={t('manualTracking')}
                    className={FIELD_CLASSES}
                  />
                </div>
              )}
              <Button
                type="button"
                onClick={() => create(carrier)}
                disabled={
                  busy !== null ||
                  !carrier ||
                  (carrier === 'manual' && (!manualName.trim() || !manualTracking.trim()))
                }
                variant="default"
              >
                {failed ? t('retry') : t('create')}
              </Button>
            </>
          )}
        </div>
      )}

      <Modal
        isOpen={confirmReturn}
        onClose={() => setConfirmReturn(false)}
        title={t('confirmReturnTitle')}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">{t('confirmReturnDescription')}</p>
        <label className="mt-4 flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={restock}
            onChange={e => setRestock(e.target.checked)}
            className="h-5 w-5"
          />
          {t('restockLabel')}
        </label>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setConfirmReturn(false)}
            disabled={busy !== null}
          >
            {t('keep')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy !== null}
            isLoading={busy === 'status'}
            onClick={async () => {
              if (!shipment) return;
              await run('status', () =>
                apiPost(`${base}/shipments/${shipment.id}/status`, { status: 'returned', restock })
              );
              setConfirmReturn(false);
            }}
          >
            {t('confirmReturn')}
          </Button>
        </div>
      </Modal>
      <ConfirmActionModal
        open={confirmCancel}
        title={t('confirmCancelTitle')}
        description={t('confirmCancelDescription')}
        confirmLabel={t('cancel')}
        cancelLabel={t('keep')}
        variant="destructive"
        isLoading={busy === 'cancel'}
        onConfirm={() => void cancel(false)}
        onClose={() => setConfirmCancel(false)}
      />
      <ConfirmActionModal
        open={forceCancel}
        title={t('forceCancelTitle')}
        description={t('forceCancelDescription')}
        confirmLabel={t('forceCancel')}
        cancelLabel={t('keep')}
        variant="destructive"
        isLoading={busy === 'cancel'}
        onConfirm={() => void cancel(true)}
        onClose={() => setForceCancel(false)}
      />
    </section>
  );
}
