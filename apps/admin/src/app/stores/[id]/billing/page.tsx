'use client';

/**
 * Merchant Billing — /stores/:id/billing (SP5 task 1).
 *
 * Shows the store's plan and subscription state, usage against every limit as
 * bars, what the plan includes, EGP subscription checkout (hosted card page),
 * plan changes (upgrade now / downgrade at period end), cancel + resume, the
 * dunning banner and the list of charges (SP5 task 3). Super-admins also get a
 * plan picker here (e.g. to comp a store), backed by
 * PUT /admin/stores/:id/subscription.
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
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
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
  billing?: {
    billingInterval: 'monthly' | 'yearly';
    pendingPlanCode: string | null;
    nextRetryAt: string | null;
    dunningAttempts: number;
    hasPaymentMethod: boolean;
    billedByPlatform: boolean;
  };
  provider?: 'kashier' | 'stub';
}

interface Charge {
  id: string;
  type: 'checkout' | 'renewal' | 'upgrade' | 'refund';
  planCode: string | null;
  amountMinor: number;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  failureReason: string | null;
  attempt: number;
  createdAt: string;
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
  const [charges, setCharges] = useState<Charge[]>([]);
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [busy, setBusy] = useState<string | null>(null);
  const [returnState, setReturnState] = useState<'idle' | 'pending' | 'ok' | 'failed' | 'later'>(
    'idle'
  );
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

  const loadCharges = useCallback(async () => {
    const { data: d } = await apiGet<{ charges: Charge[] }>(
      `/api/v1/stores/${storeId}/billing/invoices`
    );
    if (d) setCharges(d.charges ?? []);
  }, [storeId]);

  useEffect(() => {
    if (storeId) {
      load();
      loadCharges();
    }
  }, [load, loadCharges, storeId]);

  // Back from the hosted card page: the browser's word is only a hint, so ask
  // the API for the ledger status (updated by the signed webhook) and poll briefly.
  useEffect(() => {
    if (!storeId || typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    if (qs.get('checkout') !== 'return') return;
    let cancelled = false;
    setReturnState('pending');
    (async () => {
      for (let i = 0; i < 6 && !cancelled; i++) {
        const { data: r } = await apiGet<{ hint: string; status: string | null }>(
          `/api/v1/stores/${storeId}/billing/checkout/return?${qs.toString()}`
        );
        if (r?.status === 'succeeded') {
          setReturnState('ok');
          await Promise.all([load(), loadCharges()]);
          return;
        }
        if (r?.status === 'failed') {
          setReturnState('failed');
          await loadCharges();
          return;
        }
        await new Promise(res => setTimeout(res, 3000));
      }
      if (!cancelled) setReturnState('later');
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, load, loadCharges]);

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

  async function subscribe(planCode: string) {
    setBusy(planCode);
    try {
      const { data: d, error: e } = await apiPost<{ redirectUrl: string }>(
        `/api/v1/stores/${storeId}/billing/checkout`,
        { planCode, interval }
      );
      if (e || !d) {
        toastError(t('checkoutError'), e?.message);
        return;
      }
      window.location.href = d.redirectUrl;
    } finally {
      setBusy(null);
    }
  }

  async function switchPlan(planCode: string) {
    setBusy(planCode);
    try {
      const { data: d, error: e } = await apiPost<{
        mode: 'upgraded' | 'scheduled';
        status?: 'succeeded' | 'failed' | 'pending';
      }>(`/api/v1/stores/${storeId}/billing/change-plan`, { planCode });
      if (e || !d) {
        toastError(t('changeError'), e?.message);
        return;
      }
      if (d.mode === 'scheduled') toastSuccess(t('scheduledToast'));
      else if (d.status === 'succeeded') toastSuccess(t('upgradedToast'));
      else if (d.status === 'pending') toastSuccess(t('upgradePending'));
      else toastError(t('changeError'), t('upgradeDeclined'));
      await Promise.all([load(), loadCharges()]);
    } finally {
      setBusy(null);
    }
  }

  async function cancelPlan() {
    if (!window.confirm(t('confirmCancel'))) return;
    setBusy('cancel');
    try {
      const { data: d, error: e } = await apiPost<{ mode: 'at_period_end' | 'immediate' }>(
        `/api/v1/stores/${storeId}/billing/cancel`
      );
      if (e || !d) {
        toastError(t('changeError'), e?.message);
        return;
      }
      toastSuccess(d.mode === 'immediate' ? t('canceledNowToast') : t('canceledToast'));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function resumePlan() {
    setBusy('resume');
    try {
      const { error: e } = await apiPost(`/api/v1/stores/${storeId}/billing/resume`);
      if (e) {
        toastError(t('changeError'), e.message);
        return;
      }
      toastSuccess(t('resumedToast'));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function stubConfirm(merchantOrderId: string, outcome: 'success' | 'failure') {
    setBusy(merchantOrderId);
    await apiPost(`/api/v1/stores/${storeId}/billing/checkout/stub-confirm`, {
      merchantOrderId,
      outcome,
    });
    setBusy(null);
    await Promise.all([load(), loadCharges()]);
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
  const planPrice = (p: PlanSummary) =>
    interval === 'yearly' ? p.priceYearlyMinor : p.priceMonthlyMinor;

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

          {returnState !== 'idle' && (
            <div role="status" className="rounded-xl border bg-card p-4 text-sm">
              {returnState === 'pending' && t('checkoutReturnPending')}
              {returnState === 'ok' && t('checkoutReturnOk')}
              {returnState === 'failed' && t('checkoutReturnFailed')}
              {returnState === 'later' && t('checkoutReturnLater')}
            </div>
          )}

          {data.subscription.status === 'past_due' && (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-ink"
            >
              <p className="font-semibold">{t('pastDueTitle')}</p>
              <p className="mt-1">
                {t('pastDueBody', { date: fmtDate(data.billing?.nextRetryAt ?? null) ?? '' })}
              </p>
            </div>
          )}

          {data.subscription.status === 'canceled' && (
            <div role="status" className="rounded-xl border bg-card p-4 text-sm">
              <p className="font-semibold">{t('canceledTitle')}</p>
              <p className="mt-1 text-muted-foreground">{t('canceledBody')}</p>
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
              {data.billing?.pendingPlanCode && (
                <div className="flex justify-between gap-2 sm:col-span-2">
                  <dt className="text-muted-foreground">
                    {t('pendingPlan', {
                      plan:
                        data.availablePlans.find(p => p.code === data.billing?.pendingPlanCode) !==
                        undefined
                          ? planName(
                              data.availablePlans.find(
                                p => p.code === data.billing?.pendingPlanCode
                              )!
                            )
                          : data.billing.pendingPlanCode,
                      date: fmtDate(data.subscription.currentPeriodEnd) ?? '',
                    })}
                  </dt>
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
            <h2 className="mb-1 text-base font-semibold">{t('subscribeTitle')}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{t('subscribeBody')}</p>
            <div className="mb-3 inline-flex rounded-full bg-muted p-1 text-sm" role="group">
              {(['monthly', 'yearly'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={interval === k}
                  onClick={() => setInterval(k)}
                  className={`rounded-full px-3 py-1 ${interval === k ? 'bg-foreground text-background' : ''}`}
                >
                  {t(k === 'monthly' ? 'intervalMonthly' : 'intervalYearly')}
                </button>
              ))}
            </div>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              {data.availablePlans.map(p => {
                const price = planPrice(p);
                const isCurrent = p.code === data.plan.subscribedPlanCode;
                const paid = p.code !== 'free' && p.code !== 'comped' && p.code !== 'founding_free';
                const hasCard =
                  !!data.billing?.hasPaymentMethod && data.subscription.status === 'active';
                return (
                  <div
                    key={p.code}
                    className={`rounded-lg border p-3 text-sm ${isCurrent ? 'border-primary' : ''}`}
                  >
                    <p className="font-medium">{planName(p)}</p>
                    <p className="mb-2 tabular-nums text-muted-foreground">
                      {fmtPrice(price)}
                      {price !== null && (
                        <span> {interval === 'yearly' ? t('perYear') : t('perMonth')}</span>
                      )}
                    </p>
                    {isCurrent && <Badge variant="info">{t('currentBadge')}</Badge>}
                    {!isCurrent && paid && data.subscription.status !== 'comped' && (
                      <Button
                        size="sm"
                        className="max-md:min-h-11"
                        disabled={price === null || busy !== null}
                        onClick={() => (hasCard ? switchPlan(p.code) : subscribe(p.code))}
                      >
                        {price === null
                          ? t('priceUnset')
                          : hasCard
                            ? t('switchTo')
                            : t('subscribe')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {data.billing?.hasPaymentMethod &&
              ['active', 'trialing'].includes(data.subscription.status) &&
              (data.subscription.cancelAtPeriodEnd || data.billing.pendingPlanCode ? (
                <Button
                  variant="outline"
                  className="max-md:min-h-11"
                  disabled={busy !== null}
                  onClick={resumePlan}
                >
                  {t('resumePlan')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="max-md:min-h-11"
                  disabled={busy !== null}
                  onClick={cancelPlan}
                >
                  {t('cancelPlan')}
                </Button>
              ))}
            {data.billing?.hasPaymentMethod && data.subscription.status === 'past_due' && (
              <Button
                variant="outline"
                className="max-md:min-h-11"
                disabled={busy !== null}
                onClick={cancelPlan}
              >
                {t('cancelPlan')}
              </Button>
            )}
            {data.subscription.cancelAtPeriodEnd && data.subscription.currentPeriodEnd && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('cancelsOn')} {fmtDate(data.subscription.currentPeriodEnd)}
              </p>
            )}
          </section>

          {data.provider === 'stub' &&
            charges.some(c => c.type === 'checkout' && c.status === 'pending') && (
              <section className="rounded-xl border border-dashed bg-card p-4 sm:p-6">
                <h2 className="mb-1 text-base font-semibold">{t('stubTitle')}</h2>
                <p className="mb-3 text-sm text-muted-foreground">{t('stubBody')}</p>
                {charges
                  .filter(c => c.type === 'checkout' && c.status === 'pending')
                  .map(c => (
                    <div key={c.id} className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => stubConfirm(c.id, 'success')}
                      >
                        {t('stubPay')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => stubConfirm(c.id, 'failure')}
                      >
                        {t('stubDecline')}
                      </Button>
                    </div>
                  ))}
              </section>
            )}

          <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <h2 className="mb-3 text-base font-semibold">{t('invoicesTitle')}</h2>
            {charges.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('invoicesEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-start text-xs text-muted-foreground">
                      <th className="py-2 pe-3 text-start font-medium">{t('invoiceCols.date')}</th>
                      <th className="py-2 pe-3 text-start font-medium">
                        {t('invoiceCols.description')}
                      </th>
                      <th className="py-2 pe-3 text-start font-medium">
                        {t('invoiceCols.amount')}
                      </th>
                      <th className="py-2 pe-3 text-start font-medium">
                        {t('invoiceCols.status')}
                      </th>
                      <th className="hidden py-2 text-start font-medium sm:table-cell">
                        {t('invoiceCols.reason')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {charges.map(c => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-2 pe-3 text-muted-foreground">{fmtDate(c.createdAt)}</td>
                        <td className="py-2 pe-3">
                          {t(`invoiceTypes.${c.type}`)}
                          {c.planCode ? ` · ${c.planCode}` : ''}
                          {c.type === 'renewal' && c.attempt > 0
                            ? ` · ${t('retryN', { n: c.attempt })}`
                            : ''}
                        </td>
                        <td className="py-2 pe-3 tabular-nums">
                          {c.type === 'refund' ? '−' : ''}
                          {formatMoney(c.amountMinor, locale)}
                        </td>
                        <td className="py-2 pe-3">
                          <Badge
                            variant={
                              c.status === 'succeeded'
                                ? 'success'
                                : c.status === 'failed'
                                  ? 'destructive'
                                  : 'secondary'
                            }
                          >
                            {t(`invoiceStatuses.${c.status}`)}
                          </Badge>
                        </td>
                        <td className="hidden py-2 text-muted-foreground sm:table-cell">
                          {c.failureReason ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
