'use client';

/**
 * Merchant Billing — /stores/:id/billing (SP5 task 1).
 *
 * Shows the store's plan and subscription state, usage against every limit as
 * bars, what the plan includes, and an upgrade call-to-action (a placeholder
 * until task 3 wires EGP checkout). Super-admins also get a plan picker here
 * (e.g. to comp a store), backed by PUT /admin/stores/:id/subscription.
 *
 * Orders never block checkout: past the monthly cap the store is flagged and
 * this page shows a banner instead (see PlanLimitService.noteOrderCreated).
 */

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Select, useToast } from '@force/ui';
import { formatMoney, type PlanLimits } from '@force/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useT } from '../../../../i18n/useT';

interface PlanSummary {
  code: string;
  nameEn: string;
  nameAr: string;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  limits: PlanLimits;
}

interface BillingData {
  plan: { code: string; nameEn: string; nameAr: string; subscribedPlanCode: string };
  subscription: {
    status: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'comped';
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
  };
  limits: PlanLimits;
  usage: {
    maxProducts: number | null;
    maxStaff: number | null;
    maxOrdersPerMonth: number | null;
    maxStorageMb: number | null;
    customDomain: number | null;
  };
  ordersOverLimitMonth: string | null;
  availablePlans: PlanSummary[];
}

const BAR_KEYS = ['maxProducts', 'maxStaff', 'maxOrdersPerMonth'] as const;
const FEATURE_KEYS = ['customDomain', 'abandonedCartAutomation', 'whatsappAutomation'] as const;

function UsageBar({
  label,
  used,
  limit,
  unlimitedLabel,
  usedOfLabel,
}: {
  label: string;
  used: number;
  limit: number | null;
  unlimitedLabel: string;
  usedOfLabel: string;
}) {
  const pct =
    limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const tone =
    limit !== null && used > limit ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {limit === null ? `${used.toLocaleString('en')} · ${unlimitedLabel}` : usedOfLabel}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-valuenow={used}
        className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full transition-all ${tone}`}
          style={{ width: limit === null ? '0%' : `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function StoreBillingPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('billing');
  const tCommon = useT('common');
  const tLimits = useT('plans.limits');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();

  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState(false);
  const [allPlans, setAllPlans] = useState<PlanSummary[]>([]);
  const [selectedPlan, setSelectedPlan] = useState('');
  const [assigning, setAssigning] = useState(false);
  const isSuperAdmin = user?.role === 'super_admin';

  const load = useCallback(async () => {
    setError(false);
    const { data: d, error: e } = await apiGet<BillingData>(`/api/v1/stores/${storeId}/billing`);
    if (e || !d) {
      setError(true);
      return;
    }
    setData(d);
    setSelectedPlan(d.plan.subscribedPlanCode);
  }, [storeId]);

  useEffect(() => {
    if (storeId) load();
  }, [load, storeId]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    apiGet<{ plans: PlanSummary[] }>('/api/v1/admin/plans').then(({ data: d }) => {
      if (d) setAllPlans(d.plans);
    });
  }, [isSuperAdmin]);

  async function assign() {
    setAssigning(true);
    try {
      const { error: e } = await apiPut(`/api/v1/admin/stores/${storeId}/subscription`, {
        planCode: selectedPlan,
      });
      if (e) {
        toastError(t('toasts.errorTitle'), e.message);
        return;
      }
      toastSuccess(t('toasts.assignedTitle'), t('toasts.assignedDesc', { code: selectedPlan }));
      await load();
    } finally {
      setAssigning(false);
    }
  }

  const planName = (p: { nameEn: string; nameAr: string }) =>
    locale === 'ar' ? p.nameAr : p.nameEn;
  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null;
  const fmtPrice = (minor: number | null) =>
    minor === null ? t('priceTbd') : formatMoney(minor, locale);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const overOrders = data?.ordersOverLimitMonth?.startsWith(currentMonth) ?? false;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {error && (
        <div className="rounded-xl border bg-card p-6 text-center">
          <p className="text-sm text-destructive-ink">{t('loadError')}</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 text-sm text-primary hover:underline"
          >
            {tCommon('retry')}
          </button>
        </div>
      )}
      {!error && !data && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {data && (
        <div className="space-y-4">
          {overOrders && (
            <div
              role="alert"
              className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
            >
              <p className="font-semibold">{t('overLimit.title')}</p>
              <p className="mt-1">
                {t('overLimit.body', {
                  limit: (data.limits.maxOrdersPerMonth ?? 0).toLocaleString('en'),
                })}
              </p>
            </div>
          )}

          <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">{t('currentPlan')}</p>
                <h2 className="text-xl font-semibold text-foreground">{planName(data.plan)}</h2>
              </div>
              <Badge
                variant={
                  data.subscription.status === 'past_due'
                    ? 'destructive'
                    : data.subscription.status === 'comped'
                      ? 'info'
                      : 'success'
                }
              >
                {t(`status.${data.subscription.status}`)}
              </Badge>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {data.subscription.trialEndsAt && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{t('trialEnds')}</dt>
                  <dd>{fmtDate(data.subscription.trialEndsAt)}</dd>
                </div>
              )}
              {data.subscription.currentPeriodEnd && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">
                    {data.subscription.cancelAtPeriodEnd ? t('endsOn') : t('renewsOn')}
                  </dt>
                  <dd>{fmtDate(data.subscription.currentPeriodEnd)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('platformFee')}</dt>
                <dd className="tabular-nums">
                  {(data.limits.platformFeeBps / 100).toLocaleString('en')}%
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('codFee')}</dt>
                <dd className="tabular-nums">
                  {(data.limits.codPlatformFeeBps / 100).toLocaleString('en')}%
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <h2 className="mb-4 text-base font-semibold">{t('usageTitle')}</h2>
            <div className="space-y-4">
              {BAR_KEYS.map(k => {
                const used = data.usage[k] ?? 0;
                const limit = data.limits[k];
                return (
                  <UsageBar
                    key={k}
                    label={k === 'maxOrdersPerMonth' ? t('ordersThisMonth') : tLimits(k)}
                    used={used}
                    limit={limit}
                    unlimitedLabel={t('unlimited')}
                    usedOfLabel={t('usedOf', {
                      used: used.toLocaleString('en'),
                      limit: (limit ?? 0).toLocaleString('en'),
                    })}
                  />
                );
              })}
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{tLimits('maxStorageMb')}</span>
                <span className="text-muted-foreground">
                  {data.limits.maxStorageMb === null
                    ? t('unlimited')
                    : t('storageNotTracked', {
                        limit: data.limits.maxStorageMb.toLocaleString('en'),
                      })}
                </span>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <h2 className="mb-3 text-base font-semibold">{t('includedTitle')}</h2>
            <ul className="grid gap-2 sm:grid-cols-3">
              {FEATURE_KEYS.map(k => (
                <li key={k} className="flex items-center gap-2 text-sm">
                  <Badge variant={data.limits[k] ? 'success' : 'secondary'}>
                    {data.limits[k] ? t('included') : t('notIncluded')}
                  </Badge>
                  <span>{tLimits(k)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <h2 className="mb-1 text-base font-semibold">{t('upgradeTitle')}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{t('upgradeBody')}</p>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              {data.availablePlans.map(p => (
                <div
                  key={p.code}
                  className={`rounded-lg border p-3 text-sm ${p.code === data.plan.code ? 'border-primary' : ''}`}
                >
                  <p className="font-medium">{planName(p)}</p>
                  <p className="tabular-nums text-muted-foreground">
                    {fmtPrice(p.priceMonthlyMinor)}
                    {p.priceMonthlyMinor !== null && <span> {t('perMonth')}</span>}
                  </p>
                </div>
              ))}
            </div>
            {/* Placeholder until SP5 task 3 (EGP subscription billing) wires checkout. */}
            <Button disabled aria-disabled="true" className="max-md:min-h-11">
              {t('upgradeCta')}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">{t('upgradeSoon')}</p>
          </section>

          {isSuperAdmin && (
            <section className="rounded-xl border border-dashed bg-card p-4 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">{t('adminTitle')}</h2>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-64">
                  <Select
                    label={t('adminPlanLabel')}
                    value={selectedPlan}
                    onChange={e => setSelectedPlan(e.target.value)}
                    options={allPlans.map(p => ({
                      value: p.code,
                      label: `${planName(p)} (${p.code})`,
                    }))}
                  />
                </div>
                <Button
                  onClick={assign}
                  disabled={assigning || selectedPlan === data.plan.subscribedPlanCode}
                  className="max-md:min-h-11"
                >
                  {assigning ? t('assigning') : t('adminApply')}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
