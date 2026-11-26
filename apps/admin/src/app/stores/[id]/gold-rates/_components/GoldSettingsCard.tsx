'use client';

import { useState } from 'react';
import { bpsToPercentString, parsePercentToBps } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiPut } from '../../../../../lib/api';
import type { GoldSettingsView } from './types';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
const STEPS = [1, 100, 500, 1000] as const;

export function GoldSettingsCard({
  storeId,
  settings,
  canEdit,
  onSaved,
}: {
  storeId: string;
  settings: GoldSettingsView;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useT('goldRates.settings');
  const [s, setS] = useState(settings);
  const [premium, setPremium] = useState(bpsToPercentString(settings.feedPremiumBps));
  const [maxHours, setMaxHours] = useState(String(Math.round(settings.maxAgeMinutes / 60)));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const premiumBps = parsePercentToBps(premium);
    const hours = Number(maxHours);
    if (premiumBps === null || premiumBps < -1000 || premiumBps > 1000) {
      setMsg({ ok: false, text: t('badPremium') });
      return;
    }
    if (!Number.isInteger(hours) || hours < 1 || hours > 26) {
      setMsg({ ok: false, text: t('badAge') });
      return;
    }
    setSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}/gold-rates/settings`, {
      enabled: s.enabled,
      feedEnabled: s.feedEnabled,
      feedPremiumBps: premiumBps,
      maxAgeMinutes: hours * 60,
      jumpConfirmBps: s.jumpConfirmBps,
      roundingStep: s.roundingStep,
      showBreakdown: s.showBreakdown,
    });
    setSaving(false);
    if (error) setMsg({ ok: false, text: t('failed') });
    else {
      setMsg({ ok: true, text: t('saved') });
      onSaved();
    }
  };

  const check = (label: string, hint: string, key: 'enabled' | 'feedEnabled' | 'showBreakdown') => (
    <label className="flex min-h-11 items-start gap-3 text-sm">
      <input
        type="checkbox"
        disabled={!canEdit}
        checked={s[key]}
        onChange={e => setS(v => ({ ...v, [key]: e.target.checked }))}
        className="mt-1 h-5 w-5"
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className="rounded-md border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <div className="mt-4 space-y-3">
        {check(t('enabled'), t('enabledHint'), 'enabled')}
        {check(t('feed'), t('feedHint'), 'feedEnabled')}
        {check(t('breakdown'), t('breakdownHint'), 'showBreakdown')}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium">{t('premium')}</span>
          <input
            dir="ltr"
            inputMode="decimal"
            disabled={!canEdit}
            value={premium}
            onChange={e => setPremium(e.target.value)}
            className={`${FIELD_CLASSES} mt-1 block`}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('premiumHint')}</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">{t('maxAge')}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            disabled={!canEdit}
            value={maxHours}
            onChange={e => setMaxHours(e.target.value)}
            className={`${FIELD_CLASSES} mt-1 block`}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('maxAgeHint')}</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">{t('rounding')}</span>
          <select
            disabled={!canEdit}
            value={s.roundingStep}
            onChange={e =>
              setS(v => ({ ...v, roundingStep: Number(e.target.value) as 1 | 100 | 500 | 1000 }))
            }
            className={`${FIELD_CLASSES} mt-1 block`}
          >
            {STEPS.map(step => (
              <option key={step} value={step}>
                {t(`step${String(step)}` as 'step1')}
              </option>
            ))}
          </select>
        </label>
      </div>
      {msg && (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`mt-3 text-sm ${msg.ok ? '' : 'text-destructive-ink'}`}
        >
          {msg.text}
        </p>
      )}
      {canEdit && (
        <Button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          variant="default"
          className="mt-4"
        >
          {t('save')}
        </Button>
      )}
    </section>
  );
}
