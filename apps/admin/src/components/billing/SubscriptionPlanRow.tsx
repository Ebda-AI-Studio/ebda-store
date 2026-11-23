'use client';

/**
 * The store's plan as the SUBSCRIPTION names it (Ruling B1-PLAN-SOT-1): the priced plan's own name and code, never the legacy
 * tier, and a link to the one place a super admin assigns a plan (Billing > "Assign plan", by plan code, through
 * `planService.assignPlan`). Replaces the tier selects on Settings and Features, which wrote `stores.plan` by tier.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { apiGet } from '@/lib/api';
import { useT } from '@/i18n/useT';
import { buttonVariants } from '@/components/ui/Button';

interface StorePlanInfo {
  code: string;
  nameEn: string;
  nameAr: string;
  subscribedPlanCode: string;
  /** Feature-baseline tier of the effective plan (the one source for what a plan includes). */
  featureTier?: string;
}

/**
 * The store's plan as billing resolves it. A response with no `plan` is a FAILURE (STORE-QA-13: it used to leave the row on
 * "loading" forever, so a super admin saw «بنحمّل الباقة…» next to a perfectly good matrix).
 */
export function useStorePlan(storeId: string, enabled = true) {
  const [plan, setPlan] = useState<StorePlanInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    apiGet<{ plan?: StorePlanInfo | null }>(`/api/v1/stores/${storeId}/billing`).then(
      ({ data, error }) => {
        if (!live) return;
        if (error || !data?.plan) setFailed(true);
        else setPlan(data.plan);
      }
    );
    return () => {
      live = false;
    };
  }, [storeId, enabled]);
  return { plan, failed };
}

export function SubscriptionPlanRow({
  storeId,
  state,
}: {
  storeId: string;
  /** Pass the page's own `useStorePlan` result so one request serves the row and the page. */
  state?: { plan: StorePlanInfo | null; failed: boolean };
}) {
  const t = useT('components.subscriptionPlanRow');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const own = useStorePlan(storeId, !state);
  const { plan, failed } = state ?? own;

  const name = plan ? (locale === 'ar' ? plan.nameAr : plan.nameEn) : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-foreground">{t('label')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid="subscription-plan-name">
          {failed ? t('loadError') : name ? `${name} (${plan!.subscribedPlanCode})` : t('loading')}
        </p>
      </div>
      <Link
        href={`/stores/${storeId}/billing#assign-plan`}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {t('assignLink')}
      </Link>
    </div>
  );
}
