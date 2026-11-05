'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@ebda/ui';
import { formatMoney } from '@ebda/shared';
import { apiGet, apiPost } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { cardLabel, fmtDate, planLabel } from '../../../components/billing/format';
import { InstapayPanel } from '../../../components/billing/InstapayPanel';
import { startCardSetup, useCardReturn } from '../../../components/billing/useCardReturn';
import type { BillingInfo, PlanOption } from '../../../components/billing/types';
import type { OnboardingState } from './types';

/**
 * "How will you pay" step. Nothing is charged here: a saved card is charged at
 * the end of the trial, an InstaPay choice only reserves a unique reference to
 * transfer with. Continue unlocks once either is in place.
 */
export function BillingStep({
  storeId,
  billing,
  plans,
  onBillingChange,
  onBack,
  onDone,
}: {
  storeId: string;
  billing: BillingInfo | null;
  plans: PlanOption[];
  onBillingChange: (billing: BillingInfo | null) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useT('onboarding.flow.billing');
  const tFlow = useT('onboarding.flow');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [busy, setBusy] = useState<'card' | 'instapay' | null>(null);
  const [error, setError] = useState('');
  const [cardUnavailable, setCardUnavailable] = useState(false);

  async function refresh(): Promise<BillingInfo | null> {
    const { data } = await apiGet<OnboardingState>('/api/v1/onboarding/state');
    if (data) onBillingChange(data.billing);
    return data?.billing ?? null;
  }

  const cardReturn = useCardReturn(storeId, async () => !!(await refresh())?.hasPaymentMethod);

  const showCard = billing?.trialCardMode === 'card_on_file' && !cardUnavailable;
  const showInstapay = !!billing?.instapay.available;
  const hasCard = !!billing?.hasPaymentMethod;
  const instapayChosen = billing?.billingMethod === 'instapay';
  const noOption = !showCard && !showInstapay && !hasCard && !instapayChosen;
  const canContinue = hasCard || instapayChosen;

  const nextCharge = billing?.nextCharge ?? null;
  const chargePlan = nextCharge
    ? planLabel(
        plans.find(p => p.code === nextCharge.planCode),
        nextCharge.planCode,
        locale
      )
    : '';
  const chargeDate = fmtDate(nextCharge?.at ?? billing?.trialEndsAt, locale);

  async function handleCard() {
    setError('');
    setBusy('card');
    const failed = await startCardSetup(storeId, 'onboarding');
    if (failed) {
      setBusy(null);
      if (failed.code === 'CARD_SETUP_UNAVAILABLE') setCardUnavailable(true);
      else setError(t('cardFailed'));
    }
  }

  async function handleInstapay() {
    setError('');
    setBusy('instapay');
    const { error: apiError } = await apiPost(`/api/v1/stores/${storeId}/billing/payment-method`, {
      method: 'instapay',
    });
    if (apiError) {
      setBusy(null);
      setError(
        apiError.code === 'INSTAPAY_NOT_CONFIGURED' ? t('instapayUnavailable') : t('instapayFailed')
      );
      return;
    }
    await refresh();
    setBusy(null);
  }

  const ip = billing?.instapay;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}
      {cardReturn.state !== 'idle' && (
        <div role="status" className="rounded-lg border border-border p-3 text-sm">
          {cardReturn.state === 'pending' && t('returnPending')}
          {cardReturn.state === 'ok' && t('returnOk')}
          {cardReturn.state === 'failed' && t('returnFailed')}
          {cardReturn.state === 'later' && t('returnLater')}
          {cardReturn.stubOrderId && cardReturn.state === 'pending' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={cardReturn.busy}
                onClick={() => cardReturn.simulate('success')}
              >
                {t('stubSaved')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cardReturn.busy}
                onClick={() => cardReturn.simulate('failure')}
              >
                {t('stubDecline')}
              </Button>
            </div>
          )}
        </div>
      )}

      {noOption && (
        <div role="status" className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
          {t('noOption')}
        </div>
      )}

      {(showCard || hasCard) && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="font-medium text-foreground">{t('cardTitle')}</h3>
          {hasCard ? (
            <p className="text-sm text-foreground">
              {t('cardSaved')}{' '}
              <span dir="ltr" className="font-medium">
                {cardLabel(billing?.card)}
              </span>
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {nextCharge && nextCharge.amountMinor !== null
                  ? t('cardBody', {
                      amount: formatMoney(nextCharge.amountMinor, locale, { fixedDecimals: true }),
                      interval: t(
                        billing?.billingInterval === 'yearly' ? 'intervalYearly' : 'intervalMonthly'
                      ),
                      plan: chargePlan,
                      date: chargeDate,
                    })
                  : t('cardBodyNoAmount', { date: chargeDate })}
              </p>
              <Button type="button" disabled={busy !== null} onClick={handleCard}>
                {busy === 'card' ? t('redirecting') : t('cardCta')}
              </Button>
            </>
          )}
        </section>
      )}

      {(showInstapay || instapayChosen) && ip && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="font-medium text-foreground">{t('instapayTitle')}</h3>
          {!instapayChosen ? (
            <>
              <p className="text-sm text-muted-foreground">{t('instapayBody')}</p>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                onClick={handleInstapay}
              >
                {t('instapayCta')}
              </Button>
            </>
          ) : (
            <div className="space-y-3 text-sm">
              <InstapayPanel instapay={ip} locale={locale} />
              <p className="rounded-lg bg-muted/50 p-3 text-muted-foreground">
                {t('instapayHow', { date: chargeDate })}
              </p>
            </div>
          )}
        </section>
      )}

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={!canContinue && !noOption}
          onClick={onDone}
        >
          {noOption ? t('continueAnyway') : tFlow('next')}
        </Button>
      </div>
    </div>
  );
}
