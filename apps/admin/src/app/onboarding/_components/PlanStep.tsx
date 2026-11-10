'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@ebda/shared';
import { apiPut } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { isTrialPlanCode, storePlan } from '../../../components/billing/types';
import { planLabel, TRIAL_PLAN_CODE } from '@/lib/plan-labels';
import type { PlanOption, PlanSelection } from '../../../components/billing/types';

/**
 * Plan step. Every plan starts with the Growth trial; this only records which
 * plan is billed on day 15. Before a store exists the choice is kept in state
 * (and sent with POST /onboarding/store); after, it is saved with
 * PUT /stores/:id/billing/trial-plan.
 */
export function PlanStep({
  plans,
  initial,
  storeId,
  onDone,
}: {
  plans: PlanOption[];
  initial: PlanSelection;
  storeId?: string;
  onDone: (selection: PlanSelection) => void;
}) {
  const t = useT('onboarding.flow.plan');
  const tFlow = useT('onboarding.flow');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [selection, setSelection] = useState<PlanSelection>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleNext() {
    setError('');
    if (storeId) {
      setSaving(true);
      const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/billing/trial-plan`, {
        planCode: selection.planCode,
        interval: selection.interval,
      });
      setSaving(false);
      // An extra store is included in the main store's plan: there is nothing to choose here.
      if (apiError && apiError.code !== 'PAY_ON_PARENT_STORE') {
        setError(apiError.code === 'NOT_TRIALING' ? t('notTrialing') : t('saveFailed'));
        return;
      }
    }
    storePlan(selection);
    onDone(selection);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('trialNote', { trialPlan: planLabel(TRIAL_PLAN_CODE, locale === 'ar' ? 'ar' : 'en') })}
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}
      <div className="inline-flex rounded-full bg-muted p-1 text-sm" role="group">
        {(['monthly', 'yearly'] as const).map(k => (
          <Button
            variant={selection.interval === k ? 'soft' : 'ghost'}
            size="sm"
            key={k}
            type="button"
            aria-pressed={selection.interval === k}
            onClick={() => setSelection(s => ({ ...s, interval: k }))}
          >
            {t(k === 'monthly' ? 'monthly' : 'yearly')}
            {k === 'yearly' ? ` · ${t('saveBadge')}` : ''}
          </Button>
        ))}
      </div>
      <div role="radiogroup" aria-label={t('title')} className="grid gap-3 md:grid-cols-3">
        {plans.map(p => {
          const price = selection.interval === 'yearly' ? p.priceYearlyMinor : p.priceMonthlyMinor;
          const chosen = selection.planCode === p.code;
          return (
            <button
              key={p.code}
              type="button"
              role="radio"
              aria-checked={chosen}
              onClick={() => {
                const code = p.code;
                if (isTrialPlanCode(code)) setSelection(s => ({ ...s, planCode: code }));
              }}
              className={`rounded-lg border p-4 text-start transition-colors ${
                chosen ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <span className="block font-medium text-foreground">
                {locale === 'ar' ? p.nameAr : p.nameEn}
              </span>
              <span className="mt-1 block text-sm tabular-nums text-muted-foreground">
                {price === null
                  ? t('priceTbd')
                  : `${formatMoney(price, locale, { fixedDecimals: true })} ${
                      selection.interval === 'yearly' ? t('perYear') : t('perMonth')
                    }`}
              </span>
            </button>
          );
        })}
      </div>
      <Button type="button" className="w-full" disabled={saving} onClick={handleNext}>
        {saving ? t('saving') : tFlow('next')}
      </Button>
    </div>
  );
}
