'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import type { CheckoutDeliverySettings, CheckoutDeliveryWindow } from '@force/shared';

const DEFAULT_CONFIG: CheckoutDeliverySettings = {
  note: { enabled: false, text: '', textAr: '' },
  windows: { enabled: false, items: [] },
};

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Per-store checkout delivery block editor. Platform-level — every store can
 * opt in via this page, never hardcoded to a store slug. Edits
 * `Store.settings.checkoutDelivery` (no dedicated DB column) and saves via
 * the generic store update endpoint. That endpoint shallow-merges top-level
 * `settings` keys server-side (StoreService.update), but this page still
 * reads + spreads the full settings object client-side before saving as
 * defense-in-depth, matching the "send the merged object" pattern.
 */
export default function CheckoutDeliveryPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('checkoutDelivery.page');

  const [existingSettings, setExistingSettings] = useState<Record<string, unknown>>({});
  const [config, setConfig] = useState<CheckoutDeliverySettings>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{
        store?: { settings?: Record<string, unknown> };
      }>(`/api/v1/stores/${storeId}`);
      const settings = data?.store?.settings ?? {};
      setExistingSettings(settings);
      const existing = settings.checkoutDelivery as CheckoutDeliverySettings | undefined;
      setConfig({
        note: { ...DEFAULT_CONFIG.note, ...(existing?.note ?? {}) },
        windows: {
          enabled: existing?.windows?.enabled ?? false,
          items: existing?.windows?.items ?? [],
        },
      });
    } catch (err) {
      console.error('Failed to fetch checkout delivery settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: { ...existingSettings, checkoutDelivery: config },
      });
      if (!error) {
        setMessage({ type: 'success', text: t('successMessage') });
      } else {
        setMessage({ type: 'error', text: error.message || t('failedMessage') });
      }
    } catch {
      setMessage({ type: 'error', text: t('connectionError') });
    } finally {
      setIsSaving(false);
    }
  }, [storeId, existingSettings, config, t]);

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
      <AdminLayout title={t('title')} subtitle={t('loading')}>
        <div className="animate-pulse space-y-4">
          <div className="h-40 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/settings`}>
            <Button type="button" variant="outline">
              {t('backToSettings')}
            </Button>
          </Link>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isSaving ? t('saving') : t('save')}
          </button>
        </div>
      }
    >
      <div className="space-y-4 pb-8">
        {/* Delivery info note */}
        <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('noteSectionTitle')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('noteSectionHint')}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 cursor-pointer">
              <span className="text-xs font-medium text-muted-foreground">{t('noteEnable')}</span>
              <input
                type="checkbox"
                checked={config.note.enabled}
                onChange={e => patchNote({ enabled: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-primary"
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
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t('noteTextAr')}</span>
              <textarea
                value={config.note.textAr}
                onChange={e => patchNote({ textAr: e.target.value })}
                rows={3}
                dir="rtl"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>
        </section>

        {/* Delivery windows */}
        <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('windowsSectionTitle')}</h2>
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
                className="h-4 w-4 cursor-pointer accent-primary"
              />
            </label>
          </div>

          {config.windows.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noWindowsYet')}</p>
          ) : (
            <ul className="space-y-2">
              {config.windows.items.map(w => (
                <li key={w.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto_auto] md:items-end">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('labelEn')}
                      </span>
                      <input
                        type="text"
                        value={w.label}
                        onChange={e => updateWindow(w.id, { label: e.target.value })}
                        className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
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
                        className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
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
                        className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
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
                        className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeWindow(w.id)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      {t('remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={addWindow}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t('addWindow')}
          </button>
        </section>

        {message && (
          <div
            className={`rounded-xl p-4 text-sm ${
              message.type === 'success'
                ? 'bg-[hsl(var(--success))]/10 border border-[hsl(var(--success))]/20 text-[hsl(var(--success))]'
                : 'bg-destructive/10 border border-destructive/20 text-destructive'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
