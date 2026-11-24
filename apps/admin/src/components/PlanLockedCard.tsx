'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { buttonVariants } from '@/components/ui/Button';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import type { PlanGateInfo } from '../lib/plan-gate-registry';
import { planGateView } from '../lib/plan-gate-registry';

/**
 * What a merchant sees when a page load is refused for PLAN reasons (402 / 403 FEATURE_DISABLED): a designed upgrade card,
 * never destructive styling and never a retry (it cannot succeed until the plan changes). Says what it unlocks, which sold
 * plan includes it, and links to billing. Rendered by ErrorState for every page that hands it a plan-gate message.
 */
export function PlanLockedCard({ info, message }: { info: PlanGateInfo; message: string }) {
  const t = useT('components.planLocked');
  const locale = useLocale();
  const params = useParams();
  const storeId = typeof params?.id === 'string' ? params.id : null;
  useEffect(() => {
    window.dispatchEvent(new Event('ebda:upsell-card-shown'));
  }, []);
  const view = planGateView(info);
  const isAr = locale === 'ar';
  const planName = view.plan ? (isAr ? view.plan.nameAr : view.plan.nameEn) : null;

  const isTier = view.limitKey === 'analyticsTier';
  const title = isTier ? t('titleAnalyticsTier') : t('title');
  const unlocks = isTier
    ? view.required === 'advanced'
      ? t('unlocksAnalyticsTierAdvanced')
      : t('unlocksAnalyticsTierStandard')
    : message || t('unlocksGeneric');
  const addonHref =
    storeId && view.addonSku
      ? `/stores/${encodeURIComponent(storeId)}/billing/addons?sku=${encodeURIComponent(view.addonSku)}`
      : null;
  const href = storeId
    ? `/stores/${encodeURIComponent(storeId)}/billing${
        view.plan ? `?plan=${encodeURIComponent(view.plan.code)}` : ''
      }#plans`
    : null;

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4 py-10" role="status">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="h-1.5 w-full bg-primary" />
        <div className="p-6 sm:p-8">
          <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary-ink">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
                clipRule="evenodd"
              />
            </svg>
            {t('lockedBadge')}
          </span>
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{unlocks}</p>
          {planName && (
            <p className="mt-3 text-sm font-medium text-foreground">
              {t('availableOn', { plan: planName })}
            </p>
          )}
          {href && (
            <div className="mt-6 flex flex-wrap gap-3">
              {addonHref && (
                <Link
                  href={addonHref}
                  className={buttonVariants({ size: 'lg' })}
                  data-testid="get-addon-cta"
                >
                  {t('getAddonCta')}
                </Link>
              )}
              <Link
                href={href}
                className={buttonVariants({
                  size: 'lg',
                  variant: addonHref ? 'outline' : undefined,
                })}
              >
                {planName ? t('upgradeCta', { plan: planName }) : t('seePlansCta')}
              </Link>
              {planName && (
                <Link
                  href={`/stores/${encodeURIComponent(storeId as string)}/billing#plans`}
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                >
                  {t('seePlansCta')}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
