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

interface BillingPlan {
  plan: { code: string; nameEn: string; nameAr: string; subscribedPlanCode: string };
}

export function SubscriptionPlanRow({ storeId }: { storeId: string }) {
  const t = useT('components.subscriptionPlanRow');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [plan, setPlan] = useState<BillingPlan['plan'] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    apiGet<BillingPlan>(`/api/v1/stores/${storeId}/billing`).then(({ data, error }) => {
      if (!live) return;
      if (error || !data) setFailed(true);
      else setPlan(data.plan);
    });
    return () => {
      live = false;
    };
  }, [storeId]);

  const name = plan ? (locale === 'ar' ? plan.nameAr : plan.nameEn) : null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-foreground">{t('label')}</p>
        <p className="mt-0.5 text-sm text-muted-foreground" data-testid="subscription-plan-name">
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
