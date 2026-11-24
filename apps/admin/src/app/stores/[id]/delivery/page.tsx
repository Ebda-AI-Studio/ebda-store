'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { ShippingTabs } from '../shipping/_components/ShippingTabs';
import { apiGet, apiPut } from '../../../../lib/api';
import {
  buildCheckoutDeliverySettings,
  parseDeliveryDaysInput,
  offDaysForSave,
  offDaysFromSettings,
  hasSavedOffDays,
  hasInvalidOffDays,
} from '../../../../lib/checkout-delivery-payload';
import { DeliveryOffDaysField } from '../../../../components/DeliveryOffDaysField';
import { PackingSlipNoteField } from '../../../../components/orders/PackingSlipNoteField';
import { useT } from '@/i18n/useT';
import type { CheckoutDeliverySettings, CheckoutDeliveryWindow } from '@ebda/shared';

import { minorToDecimalString } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';
const DEFAULT_CONFIG: CheckoutDeliverySettings = {
  note: { enabled: false, text: '', textAr: '' },
  windows: { enabled: false, items: [] },
};

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Per-store checkout delivery block editor ("وقت التوصيل" tab of the shipping page). Platform-level — every store
 * can opt in via this page, never hardcoded to a store slug. Edits `Store.settings.checkoutDelivery` (no dedicated
 * DB column) and saves via the generic store update endpoint, sending ONLY this page's keys (BE:F-2): the server
 * shallow-merges top-level `settings` keys against the live row, so another page's save is never reverted by a stale
 * copy of the whole blob held here.
 */
export default function CheckoutDeliveryPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('checkoutDelivery.page');
  const tHub = useT('shippingHub');

  // The packing-slip note is the one stored key a child component edits itself (it has its own save).
  const [packingSlipNote, setPackingSlipNote] = useState<string | undefined>(undefined);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [config, setConfig] = useState<CheckoutDeliverySettings>(DEFAULT_CONFIG);
  // Per-store, opt-in minimum order value. Held as the raw EGP string the
  // merchant types (e.g. "5.000") — converted to integer piastres only on save.
  // Empty/0 = disabled.
  const [minimumOrderMajor, setMinimumOrderMajor] = useState('');
  // Per-store, opt-in owner order-invoice email. Every order in this store
  // auto-emails the rendered invoice to this address. Empty = disabled.
  const [orderInvoiceEmail, setOrderInvoiceEmail] = useState('');
  // Store-wide delivery estimate in business days, as the raw strings typed.
  // Both empty = none; saving sends an explicit null to clear a stored value.
  const [deliveryDaysMin, setDeliveryDaysMin] = useState('');
  const [deliveryDaysMax, setDeliveryDaysMax] = useState('');
  // Weekdays with no delivery (chip selection). Unset in the store = the platform default (Friday).
  const [deliveryOffDays, setDeliveryOffDays] = useState<number[]>([5]);
  // Whether the store already holds a saved choice: the untouched default is never written.
  const [offDaysSaved, setOffDaysSaved] = useState(false);
  const [offDaysInvalid, setOffDaysInvalid] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  const fetchSettings = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{
        store?: { settings?: Record<string, unknown> };
      }>(`/api/v1/stores/${storeId}`);
      const settings = data?.store?.settings ?? {};
      setPackingSlipNote(settings.packingSlipNote as string | undefined);
      const existing = settings.checkoutDelivery as CheckoutDeliverySettings | undefined;
      setConfig({
        note: { ...DEFAULT_CONFIG.note, ...(existing?.note ?? {}) },
        windows: {
          enabled: existing?.windows?.enabled ?? false,
          items: existing?.windows?.items ?? [],
        },
      });
      const existingMinFils = settings.minimumOrderFils;
      setMinimumOrderMajor(
        typeof existingMinFils === 'number' && existingMinFils > 0
          ? minorToDecimalString(existingMinFils)
          : ''
      );
      setOrderInvoiceEmail(
        typeof settings.orderInvoiceEmail === 'string' ? settings.orderInvoiceEmail : ''
      );
      const dd = settings.deliveryDays as { min?: unknown; max?: unknown } | null | undefined;
      setDeliveryDaysMin(typeof dd?.min === 'number' ? String(dd.min) : '');
      setDeliveryDaysMax(typeof dd?.max === 'number' ? String(dd.max) : '');
      setDeliveryOffDays(offDaysFromSettings(settings.deliveryOffDays));
      setOffDaysSaved(hasSavedOffDays(settings.deliveryOffDays));
      setOffDaysInvalid(hasInvalidOffDays(settings.deliveryOffDays));
      setBaseline(null); // re-armed by the effect below once the loaded values are in state
    } catch (err) {
      console.error('Failed to fetch checkout delivery settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Everything the merchant can edit here, as one string: the sticky Save bar shows while it differs from the
  // last loaded/saved copy.
  const snapshot = useMemo(
    () =>
      JSON.stringify([
        config,
        minimumOrderMajor,
        orderInvoiceEmail,
        deliveryDaysMin,
        deliveryDaysMax,
        deliveryOffDays,
      ]),
    [
      config,
      minimumOrderMajor,
      orderInvoiceEmail,
      deliveryDaysMin,
      deliveryDaysMax,
      deliveryOffDays,
    ]
  );
  useEffect(() => {
    if (!isLoading && baseline === null) setBaseline(snapshot);
  }, [isLoading, baseline, snapshot]);
  const dirty = baseline !== null && snapshot !== baseline;

  const handleSave = useCallback(async () => {
    const days = parseDeliveryDaysInput(deliveryDaysMin, deliveryDaysMax);
    if (!days.ok) {
      toastError(t('errorTitle'), t('deliveryDaysInvalid'));
      return;
    }
    const off = offDaysForSave(deliveryOffDays, offDaysSaved, offDaysInvalid);
    if (!off.ok) {
      toastError(t('errorTitle'), t('deliveryOffDaysAllOff'));
      return;
    }
    setIsSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: buildCheckoutDeliverySettings({
          config,
          minimumOrderMajor,
          orderInvoiceEmail,
          deliveryDays: days.value,
          deliveryOffDays: off.value,
        }),
      });
      if (!error) {
        if (off.value !== undefined) {
          setOffDaysSaved(off.value !== null);
          setOffDaysInvalid(false);
        }
        setBaseline(snapshot);
        toastSuccess(t('successMessage'), '');
      } else {
        toastError(t('errorTitle'), error.message || t('failedMessage'));
      }
    } catch {
      toastError(t('errorTitle'), t('connectionError'));
    } finally {
      setIsSaving(false);
    }
  }, [
    storeId,
    snapshot,
    config,
    minimumOrderMajor,
    orderInvoiceEmail,
    deliveryDaysMin,
    deliveryDaysMax,
    deliveryOffDays,
    offDaysSaved,
    offDaysInvalid,
    t,
    toastSuccess,
    toastError,
  ]);

  const patchNote = (next: Partial<CheckoutDeliverySettings['note']>) =>
    setConfig(prev => ({ ...prev, note: { ...prev.note, ...next } }));

  const patchWindows = (next: Partial<CheckoutDeliverySettings['windows']>) =>
    setConfig(prev => ({ ...prev, windows: { ...prev.windows, ...next } }));

  const addWindow = () => {
    const newWindow: CheckoutDeliveryWindow = {
      id: genId(),
      label: '',
      labelAr: '',
      start: '09:00',
      end: '17:00',
    };
    // orderBy intentionally omitted — unset falls back to `start`, matching
    // the pre-existing "closes at start" behavior until the merchant opts in.
    patchWindows({ items: [...config.windows.items, newWindow] });
  };

  const updateWindow = (id: string, next: Partial<CheckoutDeliveryWindow>) => {
    patchWindows({
      items: config.windows.items.map(w => (w.id === id ? { ...w, ...next } : w)),
    });
  };

  const removeWindow = (id: string) => {
    patchWindows({ items: config.windows.items.filter(w => w.id !== id) });
  };

  if (isLoading) {
    return (
      <AdminLayout title={tHub('title')}>
        <ShippingTabs />
        <div className="animate-pulse space-y-4">
          <div className="h-40 rounded-md bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={tHub('title')} subtitle={t('subtitle')}>
      <ShippingTabs />
      <div className="space-y-4 pb-24">
        {/* Delivery info note */}
        <section className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 data-setting-id="delivery.note" className="text-sm font-semibold text-foreground">
                {t('noteSectionTitle')}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('noteSectionHint')}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 cursor-pointer">
              <span className="text-xs font-medium text-muted-foreground">{t('noteEnable')}</span>
              <input
                type="checkbox"
                checked={config.note.enabled}
                onChange={e => patchNote({ enabled: e.target.checked })}
                className="h-5 w-5 cursor-pointer accent-primary"
              />
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t('noteTextEn')}</span>
              <textarea
                value={config.note.text}
                onChange={e => patchNote({ text: e.target.value })}
                rows={3}
                className={TEXTAREA_CLASSES}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t('noteTextAr')}</span>
              <textarea
                value={config.note.textAr}
                onChange={e => patchNote({ textAr: e.target.value })}
                rows={3}
                dir="rtl"
                className={TEXTAREA_CLASSES}
              />
            </label>
          </div>
        </section>

        {/* Delivery windows */}
        <section className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2
                data-setting-id="delivery.windows"
                className="text-sm font-semibold text-foreground"
              >
                {t('windowsSectionTitle')}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('windowsSectionHint')}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 cursor-pointer">
              <span className="text-xs font-medium text-muted-foreground">
                {t('windowsEnable')}
              </span>
              <input
                type="checkbox"
                checked={config.windows.enabled}
                onChange={e => patchWindows({ enabled: e.target.checked })}
                className="h-5 w-5 cursor-pointer accent-primary"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 border-t pt-3 md:max-w-xs">
            <span
              data-setting-id="delivery.days-ahead"
              className="text-sm font-semibold text-foreground"
            >
              {t('daysAheadTitle')}
            </span>
            <span className="text-xs text-muted-foreground">{t('daysAheadHint')}</span>
            <select
              value={config.daysAhead ?? ''}
              onChange={e => {
                const v = e.target.value;
                setConfig(prev => {
                  const { daysAhead: _drop, ...rest } = prev;
                  return v === ''
                    ? { ...rest, daysAhead: null }
                    : { ...rest, daysAhead: Number(v) };
                });
              }}
              aria-label={t('daysAheadLabel')}
              className={FIELD_CLASSES}
            >
              <option value="">{t('daysAheadOff')}</option>
              {Array.from({ length: 14 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          {config.windows.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noWindowsYet')}</p>
          ) : (
            <ul className="space-y-2">
              {config.windows.items.map(w => (
                <li key={w.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto_auto_auto] md:items-end">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('labelEn')}
                      </span>
                      <input
                        type="text"
                        value={w.label}
                        onChange={e => updateWindow(w.id, { label: e.target.value })}
                        className={FIELD_CLASSES}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('labelAr')}
                      </span>
                      <input
                        type="text"
                        value={w.labelAr}
                        onChange={e => updateWindow(w.id, { labelAr: e.target.value })}
                        dir="rtl"
                        className={FIELD_CLASSES}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('startTime')}
                      </span>
                      <input
                        type="time"
                        value={w.start}
                        onChange={e => updateWindow(w.id, { start: e.target.value })}
                        className={FIELD_CLASSES}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('endTime')}
                      </span>
                      <input
                        type="time"
                        value={w.end}
                        onChange={e => updateWindow(w.id, { end: e.target.value })}
                        className={FIELD_CLASSES}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('orderByTime')}
                      </span>
                      <input
                        type="time"
                        value={w.orderBy ?? ''}
                        onChange={e => updateWindow(w.id, { orderBy: e.target.value || undefined })}
                        className={FIELD_CLASSES}
                      />
                    </label>
                    <Button
                      type="button"
                      onClick={() => removeWindow(w.id)}
                      variant="ghost"
                      size="sm"
                      className="text-destructive-ink"
                    >
                      {t('remove')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Button type="button" onClick={addWindow} variant="outline" size="sm">
            {t('addWindow')}
          </Button>
        </section>

        {/* Minimum order value — opt-in per-store floor on the items
            subtotal. Platform-level: works for any store via this config,
            never hardcoded to a slug. Empty/0 = disabled. */}
        <section className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div>
            <h2
              data-setting-id="delivery.min-order"
              className="text-sm font-semibold text-foreground"
            >
              {t('minOrderSectionTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('minOrderSectionHint')}</p>
          </div>
          <label className="flex max-w-[200px] flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('minOrderLabel')}</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={minimumOrderMajor}
              onChange={e => setMinimumOrderMajor(e.target.value)}
              placeholder={t('minOrderPlaceholder')}
              className={FIELD_CLASSES}
            />
          </label>
        </section>

        {/* Store-wide delivery estimate (business days): the storefront "arrives between"
            line falls back to it when no shipping zone carries a day estimate (area-rate
            stores). Both empty = hidden. */}
        <section className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div>
            <h2 data-setting-id="delivery.days" className="text-sm font-semibold text-foreground">
              {t('deliveryDaysTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('deliveryDaysHint')}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-28 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('deliveryDaysMin')}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={30}
                step={1}
                value={deliveryDaysMin}
                onChange={e => setDeliveryDaysMin(e.target.value)}
                className={FIELD_CLASSES}
              />
            </label>
            <label className="flex w-28 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('deliveryDaysMax')}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={30}
                step={1}
                value={deliveryDaysMax}
                onChange={e => setDeliveryDaysMax(e.target.value)}
                className={FIELD_CLASSES}
              />
            </label>
            <Button
              type="button"
              onClick={() => {
                setDeliveryDaysMin('');
                setDeliveryDaysMax('');
              }}
              disabled={deliveryDaysMin === '' && deliveryDaysMax === ''}
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
            >
              {t('deliveryDaysClear')}
            </Button>
          </div>
          <div className="space-y-2 border-t border-border pt-3">
            <div>
              <h3
                data-setting-id="delivery.off-days"
                className="text-sm font-semibold text-foreground"
              >
                {t('deliveryOffDaysTitle')}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('deliveryOffDaysHint')}</p>
            </div>
            <DeliveryOffDaysField value={deliveryOffDays} onChange={setDeliveryOffDays} />
          </div>
        </section>

        {/* Owner order-invoice email — opt-in per-store. Every order in this
            store auto-emails the rendered invoice to this address (e.g. the
            store owner). Empty = disabled. Platform-level, not slug-hardcoded. */}
        <section className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div>
            <h2
              data-setting-id="delivery.invoice-email"
              className="text-sm font-semibold text-foreground"
            >
              {t('invoiceEmailSectionTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('invoiceEmailSectionHint')}</p>
          </div>
          <label className="flex max-w-[320px] flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('invoiceEmailLabel')}
            </span>
            <input
              type="email"
              value={orderInvoiceEmail}
              onChange={e => setOrderInvoiceEmail(e.target.value)}
              placeholder={t('invoiceEmailPlaceholder')}
              className={FIELD_CLASSES}
            />
          </label>
        </section>

        {!isLoading && (
          <section className="space-y-1 rounded-md border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">
              {t('orderBarcodeMoved.title')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('orderBarcodeMoved.body')}</p>
            <Link
              href={`/stores/${storeId}/codes?tab=receipt`}
              className="inline-block text-sm font-medium text-primary-ink underline underline-offset-2"
            >
              {t('orderBarcodeMoved.link')}
            </Link>
          </section>
        )}

        {!isLoading && (
          <PackingSlipNoteField
            storeId={storeId}
            value={packingSlipNote}
            onSaved={note => setPackingSlipNote(note)}
          />
        )}
      </div>
      <StickySaveBar
        dirty={dirty || isSaving}
        onSave={handleSave}
        onReset={() => void fetchSettings()}
        saving={isSaving}
        saveLabel={t('save')}
      />
    </AdminLayout>
  );
}
