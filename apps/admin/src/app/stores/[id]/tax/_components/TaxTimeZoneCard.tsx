'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiPut } from '@/lib/api';
import { useCurrentStore } from '@/hooks/useCurrentStore';
import { FIELD_CLASSES } from '@/components/ui/tokens';

/**
 * IANA zones offered in the picker. Ebda is an Egypt product (A3): Africa/Cairo is the
 * default and first, plus UTC. A store whose saved zone is not listed still shows it
 * (see `options`), so opening this card never silently rewrites a valid zone.
 */
export const TIME_ZONES = ['Africa/Cairo', 'UTC'] as const;

/**
 * The store's ONE time zone (Ruling FRT-2): finance reports, P&L, trial balance,
 * balance sheet and filed VAT periods count days in it, AND the storefront uses it
 * for checkout delivery-window cutoffs and the dates customers see (issue 2431 -
 * the copy says all of that). It was settable by nothing
 * but a SQL UPDATE (issue 2411). Saves through `PUT /stores/:id`, which
 * rejects a name that is not a real IANA zone, then refetches the cached store
 * so the Reports pickers pick the new zone up.
 */
export function TaxTimeZoneCard({ storeId }: { storeId: string }) {
  const t = useT('tax.timeZone');
  const { success: toastSuccess, error: toastError } = useToast();
  const { store, refetch } = useCurrentStore(storeId);
  const [value, setValue] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (store?.timezone) setValue(store.timezone);
  }, [store?.timezone]);

  if (!store) return null;

  const saved = store.timezone;
  const options: string[] = [...TIME_ZONES];
  if (saved && !options.includes(saved)) options.unshift(saved);

  async function save(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}`, { timezone: next });
    setSaving(false);
    if (error) {
      setValue(previous);
      toastError(error.message);
      return;
    }
    toastSuccess(t('saved'));
    await refetch();
  }

  return (
    <div className="bg-card rounded-xl border border-border p-6 mb-6">
      <h2 data-setting-id="tax.time-zone" className="text-lg font-semibold text-foreground mb-1">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground mb-4">{t('description')}</p>
      <label className="flex w-fit items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('label')}</span>
        <select
          value={value}
          disabled={saving}
          onChange={e => void save(e.target.value)}
          dir="ltr"
          className={FIELD_CLASSES}
        >
          {options.map(z => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
