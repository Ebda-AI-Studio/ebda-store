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
 * Signup funnel additions: trial/plan summary, payment method (card on file or
 * InstaPay with a "I paid" confirmation), billing notices, and "Go live".
 *
 * Orders never block checkout: past the monthly cap the store is flagged and
 * this page shows a banner instead (see PlanLimitService.noteOrderCreated).
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Select, useToast } from '@ebda/ui';
import { billingDisplayStatus, showPeriodEnd, trialDaysLeft } from '@/lib/billing-state';
import { Button } from '@/components/ui/Button';
import { formatMoney, type PlanLimits, withNumerals } from '@ebda/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useT } from '../../../../i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { DataTable } from '@/components/mobile/DataTable';
import { InstapayPanel } from '../../../../components/billing/InstapayPanel';
import { SupportLink } from '../../../../components/billing/SupportLink';
import { InstapayReceiptForm } from '../../../../components/instapay/InstapayReceiptForm';
import {
  cardLabel,
  fmtDate as fmtBillingDate,
  planLabel,
} from '../../../../components/billing/format';
import { EbdaBillingReceipt } from '../../../../components/billing/EbdaBillingReceipt';
import { pickReceiptCharge } from '../../../../components/billing/receipt-charge';
import { billingNotice, isRenewalOnly, noticeText } from '../../../../components/billing/notice';
import { startCardSetup, useCardReturn } from '../../../../components/billing/useCardReturn';
import type {
  BillingInfo,
  PaymentClaim,
  PlatformVatLine,
} from '../../../../components/billing/types';

interface PlanSummary {
  code: string;
  nameEn: string;
  nameAr: string;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  limits: PlanLimits;
  /** /admin/plans only: false = a hidden compatibility plan (never offered to merchants). */
  isPublic?: boolean;
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
  billing?: BillingInfo;
  /** Set when this store is beyond the owner's store allowance: paying here buys nothing. */
  payOnStore?: string | null;
  /** true: this store is a child INCLUDED in the main store's plan (not paused). */
  payOnStoreIncluded?: boolean;
  storeStatus?: 'active' | 'inactive' | 'suspended';
  provider?: 'kashier' | 'stub' | null;
}

/** `POST /billing/instapay-plan`: what to transfer for the plan just picked. */
interface InstapayQuote {
  handle: string | null;
  qrUrl?: string | null;
  reference: string | null;
  planCode: string;
  interval: 'monthly' | 'yearly';
  amountMinor: number | null;
  vat?: PlatformVatLine | null;
}

interface Charge {
  id: string;
  type: 'checkout' | 'renewal' | 'upgrade' | 'refund' | 'card_setup' | 'manual_payment';
  planCode: string | null;
  amountMinor: number;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  failureReason: string | null;
  attempt: number;
  createdAt: string;
  /** Ebda VAT inside amountMinor (0 / absent = no VAT line). */
  vatMinor?: number;
  vat?: PlatformVatLine | null;
}

const BAR_KEYS = ['maxProducts', 'maxStaff', 'maxOrdersPerMonth'] as const;
// `whatsappAutomation` is not listed: the WhatsApp Business API is flagged OFF for
// every store (Ruling WHATSAPP-OFF-1), so it is not a plan benefit shown to merchants.
const FEATURE_KEYS = ['customDomain', 'abandonedCartAutomation'] as const;

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
    limit !== null && used > limit ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';
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
  const askConfirm = useConfirm();
  const tLimits = useT('plans.limits');
  const tNotice = useT('billing.notice');
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
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [returnChargeId, setReturnChargeId] = useState<string | null>(null);
  const [returnState, setReturnState] = useState<'idle' | 'pending' | 'ok' | 'failed' | 'later'>(
    'idle'
  );
  const [claims, setClaims] = useState<PaymentClaim[]>([]);
  const [quote, setQuote] = useState<InstapayQuote | null>(null);
  const [cardUnavailable, setCardUnavailable] = useState(false);
  const [goLiveError, setGoLiveError] = useState('');
  const [highlightPlan, setHighlightPlan] = useState<string | null>(null);
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

  const loadClaims = useCallback(async () => {
    const { data: d } = await apiGet<{ claims?: PaymentClaim[] }>(
      `/api/v1/stores/${storeId}/billing/payment-claims`
    );
    setClaims(d?.claims ?? []);
  }, [storeId]);

  useEffect(() => {
    if (storeId) {
      load();
      loadCharges();
      loadClaims();
    }
  }, [load, loadCharges, loadClaims, storeId]);

  // Upgrade prompts link to `#plans`; the section only exists once the data is in.
  const dataReady = !!data;
  useEffect(() => {
    if (!dataReady || typeof window === 'undefined' || window.location.hash !== '#plans') return;
    document.getElementById('plans')?.scrollIntoView?.({ block: 'start' });
  }, [dataReady]);

  // `?plan=<code>` comes from the upsell dialog: mark that plan below.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setHighlightPlan(new URLSearchParams(window.location.search).get('plan'));
  }, []);

  // Back from the hosted card-save page (`?card=return`). Nothing was charged;
  // the signed webhook flips `hasPaymentMethod`, so poll for that.
  const cardReturn = useCardReturn(storeId, async () => {
    const { data: d } = await apiGet<BillingData>(`/api/v1/stores/${storeId}/billing`);
    if (d) setData(d);
    if (!d?.billing?.hasPaymentMethod) return false;
    void loadCharges();
    return true;
  });

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
        const { data: r } = await apiGet<{
          hint: string;
          status: string | null;
          chargeId?: string | null;
        }>(`/api/v1/stores/${storeId}/billing/checkout/return?${qs.toString()}`);
        if (r?.status === 'succeeded') {
          setReturnChargeId(r.chargeId ?? null);
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
    const ok = await askConfirm({
      object: t('cancelObject'),
      consequence: t('confirmCancel'),
      confirmLabel: t('cancelAction'),
    });
    if (!ok) return;
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

  async function addCard() {
    setBusy('card');
    const failed = await startCardSetup(storeId, 'billing');
    if (failed) {
      setBusy(null);
      if (failed.code === 'CARD_SETUP_UNAVAILABLE') setCardUnavailable(true);
      else toastError(t('pay.cardFailed'));
    }
  }

  async function chooseInstapay() {
    setBusy('instapay');
    try {
      const { error: e } = await apiPost(`/api/v1/stores/${storeId}/billing/payment-method`, {
        method: 'instapay',
      });
      if (e) {
        toastError(
          e.code === 'INSTAPAY_NOT_CONFIGURED'
            ? t('pay.instapayUnavailable')
            : t('pay.instapayFailed')
        );
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  // InstaPay merchants pick a plan here (any status, canceled included): the API
  // answers what to transfer, the receipt form below sends the proof.
  async function chooseInstapayPlan(planCode: string) {
    setBusy(planCode);
    try {
      if (!instapayChosen) {
        const { error: methodError } = await apiPost(
          `/api/v1/stores/${storeId}/billing/payment-method`,
          { method: 'instapay' }
        );
        if (methodError) {
          toastError(
            methodError.code === 'INSTAPAY_NOT_CONFIGURED'
              ? t('pay.instapayUnavailable')
              : t('pay.instapayFailed')
          );
          return;
        }
      }
      const { data: d, error: e } = await apiPost<InstapayQuote>(
        `/api/v1/stores/${storeId}/billing/instapay-plan`,
        { planCode, interval }
      );
      if (e || !d) {
        toastError(t('instapayPlanFailed'), e?.message);
        return;
      }
      setQuote(d);
      await load();
      document.getElementById('instapay-pay')?.scrollIntoView?.({ block: 'start' });
    } finally {
      setBusy(null);
    }
  }

  async function onReceiptSent() {
    toastSuccess(t('pay.claimSent'));
    await Promise.all([loadClaims(), load()]);
  }

  async function goLive() {
    setGoLiveError('');
    setBusy('golive');
    try {
      const { error: err } = await apiPost(`/api/v1/onboarding/stores/${storeId}/go-live`);
      if (err) {
        // 402s carry a localized message (payment method required, trial over, ...).
        setGoLiveError(err.status === 402 && err.message ? err.message : t('goLive.failed'));
        return;
      }
      toastSuccess(t('goLive.done'));
      await load();
    } finally {
      setBusy(null);
    }
  }

  const planName = (p: { nameEn: string; nameAr: string }) =>
    locale === 'ar' ? p.nameAr : p.nameEn;
  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(
          locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB',
          withNumerals({
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        )
      : null;
  const fmtPrice = (minor: number | null) =>
    minor === null ? t('priceTbd') : formatMoney(minor, locale, { fixedDecimals: true });
  const planPrice = (p: PlanSummary) =>
    interval === 'yearly' ? p.priceYearlyMinor : p.priceMonthlyMinor;

  const info = data?.billing;
  const notice = billingNotice(info);
  const noticeCopy = info && notice ? noticeText(notice, info, tNotice, locale) : null;
  const noticeUrgent = notice === 'unpaid' || notice === 'overdue' || notice === 'overStoreLimit';
  const chosenPlan = data?.availablePlans.find(p => p.code === info?.pendingPlanCode);
  const chargePlan = data?.availablePlans.find(p => p.code === info?.nextCharge?.planCode);
  const instapay = info?.instapay;
  const instapayChosen = info?.billingMethod === 'instapay';
  // InstaPay-only deployment (BILLING_PROVIDER=none) or a store that pays by transfer: a payment is DUE, nothing is
  // charged automatically (Ruling BILLING-NONE-COPY-1).
  // Renewal wording only while the next charge is still ahead: a charge already at/behind today with nothing paid is a
  // payment awaited (#1042/#896: awaiting badge, no "renews on" date), whatever the 7-day notice window says.
  const nextChargeAhead = !!info?.nextCharge && Date.parse(info.nextCharge.at) > Date.now();
  const renewalOnly =
    isRenewalOnly(data?.subscription.status, info, !!quote) &&
    (nextChargeAhead || !info?.nextCharge);
  const instapayDue = !renewalOnly && (info?.cardBilling === false || instapayChosen);
  // QA-88: a payment is due and nothing is paid yet -> say so instead of "active".
  const displayStatus = data
    ? billingDisplayStatus(data.subscription.status, !!info?.nextCharge && instapayDue)
    : 'none';
  // What the merchant is shown to transfer: the plan just picked, else the stored quote.
  const payDetails = instapay && quote ? { ...instapay, ...quote } : instapay;
  const showCardControls =
    !cardUnavailable && (info?.trialCardMode === 'card_on_file' || !!info?.hasPaymentMethod);
  // Card payments exist only when the card mode is on or a card is already saved.
  const cardPayments = info?.trialCardMode === 'card_on_file' || !!info?.hasPaymentMethod;
  // InstaPay merchants: chose it, or have no card route. Plans are paid by transfer.
  const instapayPlans =
    !!instapay && (instapay.available || instapayChosen) && (instapayChosen || !cardPayments);
  // Beyond the owner's store allowance: paying on this store buys nothing.
  const payOnOtherStore = data?.payOnStore ?? null;
  const showPaymentMethod =
    !!info &&
    !payOnOtherStore &&
    (showCardControls ||
      !!instapay?.available ||
      instapayChosen ||
      claims.length > 0 ||
      !!info.card);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const overOrders = data?.ordersOverLimitMonth?.startsWith(currentMonth) ?? false;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {error && (
        <div className="rounded-xl border bg-card p-6 text-center">
          <p className="text-sm text-destructive-ink">{t('loadError')}</p>
          <Button variant="link" size="sm" className="mt-3" type="button" onClick={load}>
            {tCommon('retry')}
          </Button>
        </div>
      )}
      {!error && !data && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {data && (
        <div className="space-y-4">
          {payOnOtherStore && (
            <div
              role="alert"
              className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning-ink"
            >
              <p className="font-semibold">
                {t(data.payOnStoreIncluded ? 'payOnStoreIncludedTitle' : 'payOnStoreTitle')}
              </p>
              <p className="mt-1">
                {t(data.payOnStoreIncluded ? 'payOnStoreIncludedBody' : 'payOnStoreBody')}
              </p>
              <Link
                href={`/stores/${payOnOtherStore}/billing`}
                className="mt-2 inline-block font-medium underline"
              >
                {t('payOnStoreLink')}
              </Link>
            </div>
          )}

          {noticeCopy && (
            <div
              role={noticeUrgent ? 'alert' : 'status'}
              className={`rounded-xl border p-4 text-sm ${
                noticeUrgent
                  ? 'border-destructive/40 bg-destructive/10 text-destructive-ink'
                  : 'border-warning/30 bg-warning/10 text-warning-ink'
              }`}
            >
              <p className="font-semibold">{noticeCopy.title}</p>
              {noticeCopy.body && <p className="mt-1">{noticeCopy.body}</p>}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {notice === 'overStoreLimit' && (
                  <a href="#plans" className="font-medium underline">
                    {tNotice('seePlans')}
                  </a>
                )}
                <SupportLink whatsappUrl={info?.supportWhatsappUrl} email={info?.supportEmail} />
              </div>
            </div>
          )}

          {cardReturn.state !== 'idle' && (
            <div role="status" className="rounded-xl border bg-card p-4 text-sm">
              {cardReturn.state === 'pending' && t('pay.returnPending')}
              {cardReturn.state === 'ok' && t('pay.returnOk')}
              {cardReturn.state === 'failed' && t('pay.returnFailed')}
              {cardReturn.state === 'later' && t('pay.returnLater')}
              {cardReturn.stubOrderId && cardReturn.state === 'pending' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={cardReturn.busy}
                    onClick={() => cardReturn.simulate('success')}
                  >
                    {t('pay.stubSaved')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cardReturn.busy}
                    onClick={() => cardReturn.simulate('failure')}
                  >
                    {t('pay.stubDecline')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {data.storeStatus === 'inactive' && (
            <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <h2 className="mb-1 text-base font-semibold">{t('goLive.title')}</h2>
              <p className="mb-3 text-sm text-muted-foreground">{t('goLive.body')}</p>
              {goLiveError && (
                <p role="alert" className="mb-3 text-sm text-destructive-ink">
                  {goLiveError}
                </p>
              )}
              <Button className="max-md:min-h-11" disabled={busy !== null} onClick={goLive}>
                {busy === 'golive' ? t('goLive.working') : t('goLive.cta')}
              </Button>
            </section>
          )}

          {overOrders && (
            <div
              role="alert"
              className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning-ink"
            >
              <p className="font-semibold">{t('overLimit.title')}</p>
              <p className="mt-1">
                {t('overLimit.body', {
                  limit: (data.limits.maxOrdersPerMonth ?? 0).toLocaleString('en'),
                })}
              </p>
              {!payOnOtherStore && (
                <a href="#plans" className="mt-2 inline-block font-medium underline">
                  {tNotice('seePlans')}
                </a>
              )}
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

          {/* Paid: the receipt prints out (reused storefront printer, Ebda palette, palm barcode).
              Any earlier succeeded charge can be re-opened from the invoices table. */}
          {(() => {
            const { charge: paidCharge, processing } = pickReceiptCharge(charges, {
              returnChargeId: returnState === 'ok' ? returnChargeId : null,
              openedId: receiptFor,
            });
            if (!paidCharge) {
              return processing ? (
                <p role="status" className="rounded-xl border bg-card p-4 text-sm">
                  {t('receiptProcessing')}
                </p>
              ) : null;
            }
            return (
              <EbdaBillingReceipt
                key={paidCharge.id}
                charge={paidCharge}
                planName={
                  paidCharge.planCode === data.plan.subscribedPlanCode
                    ? planLabel(data.plan, paidCharge.planCode ?? '', locale)
                    : undefined
                }
                locale={locale}
              />
            );
          })()}

          {data.subscription.status === 'past_due' &&
            data.billing?.billingMethod !== 'instapay' && (
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
                  displayStatus === 'past_due'
                    ? 'destructive'
                    : displayStatus === 'comped' || displayStatus === 'trialing'
                      ? 'info'
                      : displayStatus === 'awaiting_payment'
                        ? 'warning'
                        : 'success'
                }
              >
                {t(`status.${displayStatus}`)}
              </Badge>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {data.subscription.trialEndsAt && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{t('trialEnds')}</dt>
                  <dd>{fmtDate(data.subscription.trialEndsAt)}</dd>
                </div>
              )}
              {data.subscription.currentPeriodEnd &&
                showPeriodEnd(displayStatus, data.subscription.cancelAtPeriodEnd) && (
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

          {info && (
            <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="text-base font-semibold">{t('trial.title')}</h2>
                <Badge
                  variant={
                    displayStatus === 'past_due'
                      ? 'destructive'
                      : displayStatus === 'trialing' || displayStatus === 'comped'
                        ? 'info'
                        : displayStatus === 'awaiting_payment'
                          ? 'warning'
                          : displayStatus === 'active'
                            ? 'success'
                            : 'secondary'
                  }
                >
                  {t(`status.${displayStatus}`)}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(`stateLine.${displayStatus}`)}
              </p>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {(info.trialEndsAt ?? data.subscription.trialEndsAt) && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t('trialEnds')}</dt>
                    <dd>{fmtDate(info.trialEndsAt ?? data.subscription.trialEndsAt)}</dd>
                  </div>
                )}
                {displayStatus === 'trialing' &&
                  trialDaysLeft(info.trialEndsAt ?? data.subscription.trialEndsAt) !== null && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{t('trialDaysLeftLabel')}</dt>
                      <dd>
                        {t('trialDaysLeft', {
                          count:
                            trialDaysLeft(info.trialEndsAt ?? data.subscription.trialEndsAt) ?? 0,
                        })}
                      </dd>
                    </div>
                  )}
                {info.pendingPlanCode && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t('trial.chosenPlan')}</dt>
                    <dd>
                      {planLabel(chosenPlan, info.pendingPlanCode, locale)} ·{' '}
                      {t(info.billingInterval === 'yearly' ? 'intervalYearly' : 'intervalMonthly')}
                    </dd>
                  </div>
                )}
                {info.nextCharge && (
                  <div className="flex justify-between gap-2 sm:col-span-2">
                    <dt className="text-muted-foreground">
                      {t(
                        instapayDue
                          ? 'trial.instapayDue'
                          : renewalOnly
                            ? 'trial.nextRenewal'
                            : 'trial.nextCharge'
                      )}
                    </dt>
                    <dd className="text-end tabular-nums">
                      {info.nextCharge.amountMinor !== null
                        ? t(
                            instapayDue
                              ? 'trial.instapayDueLine'
                              : renewalOnly
                                ? 'trial.renewalLine'
                                : 'trial.nextChargeLine',
                            {
                              amount: formatMoney(info.nextCharge.amountMinor, locale, {
                                fixedDecimals: true,
                              }),
                              interval: t(
                                info.billingInterval === 'yearly'
                                  ? 'intervalYearly'
                                  : 'intervalMonthly'
                              ),
                              plan: planLabel(chargePlan, info.nextCharge.planCode, locale),
                              date: fmtBillingDate(info.nextCharge.at, locale),
                            }
                          )
                        : t(
                            instapayDue
                              ? 'trial.instapayDueNoAmount'
                              : renewalOnly
                                ? 'trial.renewalNoAmount'
                                : 'trial.nextChargeNoAmount',
                            {
                              plan: planLabel(chargePlan, info.nextCharge.planCode, locale),
                              date: fmtBillingDate(info.nextCharge.at, locale),
                            }
                          )}
                    </dd>
                  </div>
                )}
                {info.nextCharge && instapayDue && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {t('trial.returnsToFree')}
                  </p>
                )}
              </dl>
            </section>
          )}

          {showPaymentMethod && info && (
            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <h2 className="text-base font-semibold">{t('pay.title')}</h2>

              {(showCardControls || info.card) && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">{t('pay.card')}</h3>
                  {info.hasPaymentMethod && info.card ? (
                    <p className="text-sm">
                      <span dir="ltr" className="font-medium">
                        {cardLabel(info.card)}
                      </span>
                      {info.card.savedAt && (
                        <span className="text-muted-foreground">
                          {' · '}
                          {t('pay.cardSavedOn', {
                            date: fmtBillingDate(info.card.savedAt, locale),
                          })}
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('pay.noCard')}</p>
                  )}
                  {showCardControls && (
                    <>
                      <Button
                        variant="outline"
                        className="max-md:min-h-11"
                        disabled={busy !== null}
                        onClick={addCard}
                      >
                        {busy === 'card'
                          ? t('pay.redirecting')
                          : info.hasPaymentMethod
                            ? t('pay.replaceCard')
                            : t('pay.addCard')}
                      </Button>
                      <p className="text-xs text-muted-foreground">{t('pay.cardNote')}</p>
                    </>
                  )}
                </div>
              )}

              {(instapay?.available || instapayChosen) && instapay && (
                <div className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-medium">{t('pay.instapay')}</h3>
                  {!instapayChosen ? (
                    <Button
                      variant="outline"
                      className="max-md:min-h-11"
                      disabled={busy !== null}
                      onClick={chooseInstapay}
                    >
                      {t('pay.useInstapay')}
                    </Button>
                  ) : renewalOnly ? (
                    <p
                      className="text-sm text-muted-foreground"
                      data-testid="instapay-renewal-note"
                    >
                      {t('pay.instapayRenewalNote')}
                    </p>
                  ) : (
                    <div id="instapay-pay" className="space-y-4">
                      {quote && (
                        <div className="space-y-1" data-testid="instapay-quote">
                          <p className="text-sm font-medium">
                            {t('instapayQuoteTitle', {
                              plan: planLabel(
                                data.availablePlans.find(p => p.code === quote.planCode),
                                quote.planCode,
                                locale
                              ),
                              interval: t(
                                quote.interval === 'yearly' ? 'intervalYearly' : 'intervalMonthly'
                              ),
                            })}
                          </p>
                          <p className="text-xs text-muted-foreground">{t('instapayPlanNote')}</p>
                        </div>
                      )}
                      <InstapayPanel instapay={payDetails ?? instapay} locale={locale} />
                      <InstapayReceiptForm
                        baseUrl={`/api/v1/stores/${storeId}/billing/receipts`}
                        reviewerNote={t('pay.reviewerNote')}
                        onSubmitted={onReceiptSent}
                      />
                    </div>
                  )}
                </div>
              )}

              {claims.length > 0 && (
                <div className="space-y-2 border-t pt-4">
                  <h3 className="text-sm font-medium">{t('claims.title')}</h3>
                  <ul className="space-y-2">
                    {claims.map(c => (
                      <li key={c.id} className="rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span dir="ltr" className="font-medium">
                            {c.receipt?.fields.reference ?? c.payerReference ?? c.paymentReference}
                          </span>
                          <Badge
                            variant={
                              c.status === 'confirmed'
                                ? 'success'
                                : c.status === 'rejected'
                                  ? 'destructive'
                                  : 'warning'
                            }
                          >
                            {t(`claims.status.${c.status}`)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatMoney(c.amountMinor, locale, { fixedDecimals: true })} ·{' '}
                          {fmtBillingDate(c.createdAt, locale)}
                        </p>
                        {c.reviewNote && <p className="mt-1">{c.reviewNote}</p>}
                        {c.status === 'rejected' && instapayChosen && (
                          <a
                            href="#instapay-upload"
                            className="mt-1 inline-block text-sm font-medium text-primary-ink underline"
                          >
                            {t('claims.uploadRight')}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

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
              {data.usage.maxStorageMb === null ? (
                // QA-STOR-1: the storage counter could not be read right now: say so, never show 0
                <div
                  className="flex items-baseline justify-between gap-2 text-sm"
                  data-testid="storage-usage-unknown"
                >
                  <span className="font-medium">{tLimits('maxStorageMb')}</span>
                  <span className="text-muted-foreground">
                    {t('storageUnknown')} ·{' '}
                    {data.limits.maxStorageMb === null
                      ? t('unlimited')
                      : data.limits.maxStorageMb.toLocaleString('en')}
                  </span>
                </div>
              ) : (
                <UsageBar
                  label={tLimits('maxStorageMb')}
                  used={data.usage.maxStorageMb}
                  limit={data.limits.maxStorageMb}
                  unlimitedLabel={t('unlimited')}
                  usedOfLabel={t('usedOf', {
                    used: data.usage.maxStorageMb.toLocaleString('en'),
                    limit: (data.limits.maxStorageMb ?? 0).toLocaleString('en'),
                  })}
                />
              )}
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

          <section id="plans" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            {/* InstaPay merchants pick a plan here too: it is paid by transfer and
                activated when the Ebda Store team confirms the receipt. */}
            <h2 className="mb-1 text-base font-semibold">{t('subscribeTitle')}</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              {cardPayments && !instapayChosen ? t('subscribeBody') : t('subscribeBodyInstapay')}
            </p>
            <div className="mb-3 inline-flex rounded-full bg-muted p-1 text-sm" role="group">
              {(['monthly', 'yearly'] as const).map(k => (
                <Button
                  variant={interval === k ? 'soft' : 'ghost'}
                  size="sm"
                  key={k}
                  type="button"
                  aria-pressed={interval === k}
                  onClick={() => setInterval(k)}
                >
                  {t(k === 'monthly' ? 'intervalMonthly' : 'intervalYearly')}
                </Button>
              ))}
            </div>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              {data.availablePlans.map(p => {
                const price = planPrice(p);
                const isCurrent = p.code === data.plan.subscribedPlanCode;
                const paid = p.code !== 'free' && p.code !== 'comped' && p.code !== 'founding_free';
                const hasCard =
                  !!data.billing?.hasPaymentMethod &&
                  data.subscription.status === 'active' &&
                  !instapayChosen;
                return (
                  <div
                    key={p.code}
                    className={`rounded-lg border p-3 text-sm ${
                      isCurrent || p.code === highlightPlan ? 'border-primary' : ''
                    }`}
                  >
                    <p className="font-medium">{planName(p)}</p>
                    <p className="mb-2 tabular-nums text-muted-foreground">
                      {fmtPrice(price)}
                      {price !== null && (
                        <span> {interval === 'yearly' ? t('perYear') : t('perMonth')}</span>
                      )}
                    </p>
                    {isCurrent && data.subscription.status !== 'canceled' && (
                      <Badge variant="info">{t('currentBadge')}</Badge>
                    )}
                    {(!isCurrent || data.subscription.status === 'canceled') &&
                      paid &&
                      data.subscription.status !== 'comped' &&
                      !payOnOtherStore &&
                      instapayPlans && (
                        <Button
                          size="sm"
                          className="max-md:min-h-11"
                          disabled={price === null || busy !== null}
                          onClick={() => chooseInstapayPlan(p.code)}
                        >
                          {price === null ? t('priceUnset') : t('chooseThisPlan')}
                        </Button>
                      )}
                    {!isCurrent &&
                      paid &&
                      data.subscription.status !== 'comped' &&
                      !payOnOtherStore &&
                      !instapayPlans &&
                      (cardPayments || hasCard) && (
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
            {!payOnOtherStore &&
              (data.billing?.hasPaymentMethod || instapayChosen) &&
              ['active', 'trialing'].includes(data.subscription.status) &&
              (data.subscription.cancelAtPeriodEnd || data.billing?.pendingPlanCode ? (
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
            {!payOnOtherStore &&
              (data.billing?.hasPaymentMethod || instapayChosen) &&
              data.subscription.status === 'past_due' && (
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
            {(() => {
              // Tax-invoice wording only once Ebda actually charged VAT (never while it is OFF).
              const taxed = charges.find(c => c.vat && (c.vatMinor ?? 0) > 0)?.vat;
              return taxed ? (
                <p className="mb-3 text-xs text-muted-foreground" data-testid="tax-invoice-seller">
                  {t('taxInvoiceSeller', {
                    name: taxed.legalName ?? '',
                    trn: taxed.trn ?? '',
                  })}
                </p>
              ) : null;
            })()}
            {charges.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('invoicesEmpty')}</p>
            ) : (
              <DataTable<Charge>
                ariaLabel={t('invoicesTitle')}
                columns={[
                  {
                    header: t('invoiceCols.date'),
                    primaryOnMobile: true,
                    cell: c => (
                      <span className="text-muted-foreground">{fmtDate(c.createdAt)}</span>
                    ),
                  },
                  {
                    header: t('invoiceCols.description'),
                    cell: c => (
                      <span>
                        {t(`invoiceTypes.${c.type}`)}
                        {c.planCode ? ` · ${c.planCode}` : ''}
                        {c.type === 'renewal' && c.attempt > 0
                          ? ` · ${t('retryN', { n: c.attempt })}`
                          : ''}
                      </span>
                    ),
                  },
                  {
                    header: t('invoiceCols.amount'),
                    cell: c => (
                      <span className="tabular-nums">
                        {c.type === 'refund' ? '−' : ''}
                        {formatMoney(c.amountMinor, locale, { fixedDecimals: true })}
                        {c.vat && (c.vatMinor ?? 0) > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            {t('invoiceVat', {
                              rate: c.vat.rateBps / 100,
                              vat: formatMoney(c.vatMinor ?? 0, locale, { fixedDecimals: true }),
                            })}
                            {c.vat.trn ? ` · ${t('invoiceTrn', { trn: c.vat.trn })}` : ''}
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    header: t('invoiceCols.status'),
                    mobileBadge: true,
                    cell: c => (
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
                    ),
                  },
                  {
                    header: t('invoiceCols.reason'),
                    mobileActions: true,
                    cell: c =>
                      c.status === 'succeeded' && c.type !== 'refund' ? (
                        <Button
                          variant="link"
                          size="sm"
                          type="button"
                          onClick={() => setReceiptFor(receiptFor === c.id ? null : c.id)}
                        >
                          {t('viewReceipt')}
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">{c.failureReason ?? '—'}</span>
                      ),
                  },
                ]}
                rows={charges}
                rowKey={c => c.id}
              />
            )}
          </section>

          {isSuperAdmin && (
            <section
              id="assign-plan"
              className="scroll-mt-20 rounded-xl border border-dashed bg-card p-4 sm:p-6"
            >
              <h2 className="mb-3 text-base font-semibold">{t('adminTitle')}</h2>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-64">
                  <Select
                    label={t('adminPlanLabel')}
                    value={selectedPlan}
                    onChange={e => setSelectedPlan(e.target.value)}
                    options={allPlans.map(p => ({
                      value: p.code,
                      // the priced plan by name, code and monthly price; hidden compatibility plans are marked (B1-PLAN-SOT-1)
                      label: [
                        `${planName(p)} (${p.code})`,
                        p.priceMonthlyMinor !== null
                          ? `${fmtPrice(p.priceMonthlyMinor)} ${t('perMonth')}`
                          : null,
                        p.isPublic === false ? t('adminPlanHidden') : null,
                      ]
                        .filter(Boolean)
                        .join(' · '),
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
