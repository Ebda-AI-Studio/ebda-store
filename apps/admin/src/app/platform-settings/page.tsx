'use client';

/**
 * Super-admin Platform settings — /platform-settings (ruling TAX-6).
 *
 * Today: Ebda's OWN VAT on subscription invoices. Defaults OFF because Ebda is
 * not VAT-registered yet; switching it on requires Ebda's TRN + legal name.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { useCallback, useEffect, useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import {
  DEFAULT_PLATFORM_VAT,
  PLATFORM_VAT_MODES,
  normalizeTaxRegistrationNumber,
  type PlatformVat,
  type PlatformVatMode,
} from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { Toggle } from '../../components/Toggle';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';

function PlatformSettingsInner() {
  const t = useT('platformSettings');
  const askConfirm = useConfirm();
  const { success: toastSuccess, error: toastError } = useToast();
  const [saved, setSaved] = useState<PlatformVat | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [enabled, setEnabled] = useState(DEFAULT_PLATFORM_VAT.enabled);
  const [rate, setRate] = useState(String(DEFAULT_PLATFORM_VAT.rate));
  const [mode, setMode] = useState<PlatformVatMode>(DEFAULT_PLATFORM_VAT.mode);
  const [trn, setTrn] = useState('');
  const [legalName, setLegalName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((v: PlatformVat) => {
    setSaved(v);
    setEnabled(v.enabled);
    setRate(String(v.rate));
    setMode(v.mode);
    setTrn(v.trn ?? '');
    setLegalName(v.legalName ?? '');
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await apiGet<{ vat: PlatformVat }>('/api/v1/admin/platform-vat');
      if (error || !data?.vat) setLoadError(true);
      else apply(data.vat);
      setLoading(false);
    })();
  }, [apply]);

  const save = async () => {
    setFormError(null);
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum <= 0 || rateNum > 100) {
      return setFormError(t('vat.invalidRate'));
    }
    const trnNormalized = trn.trim() ? normalizeTaxRegistrationNumber(trn) : '';
    const name = legalName.trim();
    if (trnNormalized && !/^\d{9}$/.test(trnNormalized)) return setFormError(t('vat.invalidTrn'));
    if (enabled && (!trnNormalized || name.length < 2)) {
      return setFormError(t('vat.requiredToEnable'));
    }
    // Confirm only on the OFF -> ON transition.
    if (enabled && !saved?.enabled) {
      const ok = await askConfirm({
        object: t('vat.enableObject'),
        consequence: t('vat.confirmEnable'),
        confirmLabel: t('vat.enableAction'),
        tone: 'default',
      });
      if (!ok) return;
    }

    setSaving(true);
    const { data, error } = await apiPut<{ vat: PlatformVat }>('/api/v1/admin/platform-vat', {
      enabled,
      rate: rateNum,
      mode,
      trn: trnNormalized || null,
      legalName: name || null,
    });
    setSaving(false);
    if (error || !data?.vat) {
      setFormError(t('vat.saveFailed', { message: error?.message ?? '' }));
      toastError(t('vat.saveFailed', { message: error?.message ?? '' }));
      return;
    }
    apply(data.vat);
    toastSuccess(t('vat.saved'));
  };

  if (loading) {
    return <div className="p-4 sm:p-6 text-sm text-muted-foreground">{t('loading')}</div>;
  }
  if (loadError) {
    return (
      <div className="p-4 sm:p-6">
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <section className="max-w-2xl space-y-4 rounded-xl border border-border bg-card p-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('vat.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('vat.explain')}</p>
        </div>

        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={setEnabled} disabled={saving} />
          <span className="text-sm text-foreground">{t('vat.enabled')}</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={t('vat.rate')}
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={rate}
            onChange={e => setRate(e.target.value)}
          />
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-foreground">{t('vat.mode')}</span>
            <select
              aria-label={t('vat.mode')}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={mode}
              onChange={e => setMode(e.target.value as PlatformVatMode)}
            >
              {PLATFORM_VAT_MODES.map(m => (
                <option key={m} value={m}>
                  {m === 'exclusive' ? t('vat.modeExclusive') : t('vat.modeInclusive')}
                </option>
              ))}
            </select>
          </label>
          <Input
            label={t('vat.trn')}
            dir="ltr"
            inputMode="numeric"
            value={trn}
            onChange={e => setTrn(e.target.value)}
          />
          <Input
            label={t('vat.legalName')}
            value={legalName}
            onChange={e => setLegalName(e.target.value)}
          />
        </div>

        {formError && (
          <p role="alert" className="text-sm text-destructive-ink">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {saved &&
              t('vat.lastSaved', {
                state: saved.enabled ? t('vat.stateOn') : t('vat.stateOff'),
                rate: saved.rate,
              })}
          </p>
          <Button onClick={save} disabled={saving}>
            {saving ? t('vat.saving') : t('vat.save')}
          </Button>
        </div>
      </section>
    </div>
  );
}

export default function PlatformSettingsPage() {
  const t = useT('platformSettings');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <PlatformSettingsInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
