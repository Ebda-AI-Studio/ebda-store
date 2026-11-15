'use client';

/**
 * Add-ons — /stores/:id/billing/addons (SELF-SERVICE A8 + A9). The owner buys a feature outside the plan or a pack of
 * extra daily AI requests with a card. Two steps, never one click: preview shows the exact total and mints a
 * single-use token; only the explicit "Yes, charge" sends it (with an Idempotency-Key) and opens the hosted card page.
 * Nothing turns on in the browser: the entitlement arrives from the signed payment webhook, and a page that returned
 * from the card page polls until the server says the payment settled or failed.
 * `?sku=` (from a locked screen's "Get this add-on") scrolls to that card.
 */
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { formatMoney } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { EbdaBillingReceipt } from '@/components/billing/EbdaBillingReceipt';
import { InstapayPanel } from '@/components/billing/InstapayPanel';
import { InstapayReceiptForm } from '@/components/instapay/InstapayReceiptForm';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPost, apiRequest } from '../../../../../lib/api';
import { fmtDate } from '../../../../../components/billing/format';
import { useT } from '../../../../../i18n/useT';

type AddonState =
  | 'available'
  | 'pending_payment'
  | 'waiting_confirmation'
  | 'rejected'
  | 'failed'
  | 'active'
  | 'renewing'
  | 'cancelled_at_period_end'
  | 'expired'
  | 'refunded'
  | 'included'
  | 'granted';

interface AddonRow {
  sku: string;
  kind: 'feature' | 'ai_topup';
  nameEn: string;
  nameAr: string;
  descEn: string;
  descAr: string;
  previewImage: string | null;
  priceMinor: number;
  state: AddonState;
  includedInPlan: boolean;
  active: { endsAt: string; cancelAtPeriodEnd: boolean } | null;
}
interface AddonsData {
  cardAvailable: boolean;
  instapayAvailable: boolean;
  termDays: number;
  addons: AddonRow[];
  ai: {
    baseCap: number;
    extra: number;
    cap: number;
    used: number;
    remaining: number;
    byFeature: Array<{ feature: string; count: number }>;
    packs: Array<{
      sku: string;
      extraRequests: number;
      nameEn: string;
      nameAr: string;
      endsAt: string;
    }>;
  };
}
interface HistoryRow {
  id: string;
  sku: string;
  nameEn: string;
  nameAr: string;
  status: string;
  amountMinor: number;
  vatMinor: number;
  vat: { rateBps: number; trn?: string | null } | null;
  termEnd: string | null;
  createdAt: string;
  planCode: string | null;
}
interface InstapayInfo {
  sku: string;
  nameEn: string;
  nameAr: string;
  handle: string;
  qrUrl: string | null;
  reference: string;
  amountMinor: number;
  vatMinor: number;
}
interface Preview {
  sku: string;
  nameEn: string;
  nameAr: string;
  vatMinor: number;
  totalMinor: number;
  termDays: number;
  renews: boolean;
  renewalMinor: number;
  renewsEveryDays: number;
  confirmToken: string;
  /** One key per confirmation dialog: a double click or a retry re-sends the SAME key, so the server charges once. */
  idempotencyKey: string;
}

const POLL_MS = 3000;
const POLL_MAX_MS = 90_000;
const BADGE: Record<AddonState, string> = {
  available: 'bg-muted text-muted-ink',
  pending_payment: 'bg-warning/15 text-warning-ink',
  waiting_confirmation: 'bg-warning/15 text-warning-ink',
  rejected: 'bg-destructive/10 text-destructive-ink',
  failed: 'bg-destructive/10 text-destructive-ink',
  active: 'bg-success/15 text-success-ink',
  renewing: 'bg-success/15 text-success-ink',
  cancelled_at_period_end: 'bg-warning/15 text-warning-ink',
  expired: 'bg-muted text-muted-ink',
  refunded: 'bg-muted text-muted-ink',
  included: 'bg-primary/10 text-primary-ink',
  granted: 'bg-primary/10 text-primary-ink',
};

export default function AddonsPage() {
  const storeId = useParams()?.id as string;
  const t = useT('addons');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const search = useSearchParams();
  const returned = search?.get('checkout') === 'return';
  const focusSku = search?.get('sku') ?? null;
  const { success: toastSuccess, error: toastError } = useToast();
  const [data, setData] = useState<AddonsData | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<HistoryRow | null>(null);
  const [insta, setInsta] = useState<InstapayInfo | null>(null);
  const [polling, setPolling] = useState(returned);
  const base = `/api/v1/stores/${storeId}/billing/addons`;
  const money = (minor: number) => formatMoney(minor, locale, { fixedDecimals: true });
  const name = (a: { nameEn: string; nameAr: string }) => (locale === 'ar' ? a.nameAr : a.nameEn);

  const load = useCallback(async () => {
    const [r, h] = await Promise.all([
      apiGet<AddonsData>(base),
      apiGet<{ items: HistoryRow[] }>(`${base}/history`),
    ]);
    if (r.error || !r.data) return setFailed(true);
    setFailed(false);
    setData(r.data);
    if (h.data) setHistory(h.data.items);
    return r.data;
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  // Back from the card page: ask the server (never assume) until nothing is pending, for at most 90 s.
  useEffect(() => {
    if (!polling) return;
    const startedAt = Date.now();
    const id = setInterval(async () => {
      const d = await load();
      const pending = d?.addons.some(a => a.state === 'pending_payment');
      if (!pending || Date.now() - startedAt > POLL_MAX_MS) setPolling(false);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, load]);

  useEffect(() => {
    if (focusSku && data) document.getElementById(`addon-${focusSku}`)?.scrollIntoView?.();
  }, [focusSku, data]);

  async function startBuy(sku: string) {
    setBusy(sku);
    const r = await apiPost<Omit<Preview, 'idempotencyKey'>>(`${base}/preview`, { sku });
    setBusy(null);
    if (r.error || !r.data) return toastError(t('previewError'), r.error?.message);
    setPreview({ ...r.data, idempotencyKey: crypto.randomUUID() });
  }

  async function startInstapay(sku: string) {
    setBusy(sku);
    const r = await apiGet<InstapayInfo>(`${base}/${encodeURIComponent(sku)}/instapay`);
    setBusy(null);
    if (r.error || !r.data) return toastError(t('instapayError'), r.error?.message);
    setPreview(null);
    setInsta(r.data);
  }

  async function confirmBuy() {
    if (!preview) return;
    setBusy(preview.sku);
    const r = await apiRequest<{ redirectUrl: string }>(`${base}/checkout`, {
      method: 'POST',
      headers: { 'Idempotency-Key': preview.idempotencyKey },
      body: JSON.stringify({ sku: preview.sku, confirmToken: preview.confirmToken }),
    });
    if (r.error || !r.data) {
      setBusy(null);
      setPreview(null);
      return toastError(t('checkoutError'), r.error?.message);
    }
    window.location.href = r.data.redirectUrl;
  }

  async function setRenewal(sku: string, action: 'cancel' | 'resume') {
    setBusy(sku);
    const r = await apiPost<{ effectiveAt: string }>(
      `${base}/${encodeURIComponent(sku)}/${action}`
    );
    setBusy(null);
    if (r.error || !r.data) return toastError(t('cancelError'), r.error?.message);
    if (action === 'cancel')
      toastSuccess(t('cancelDone', { date: fmtDate(r.data.effectiveAt, locale) }));
    await load();
  }

  const AI_FEATURES = [
    'translate',
    'seo',
    'categorize',
    'product-excerpt',
    'product-faq',
    'product-meta-aeo',
    'product-tags',
  ];
  const aiFeatureLabel = (f: string) => (AI_FEATURES.includes(f) ? t(`aiFeature.${f}`) : f);

  const group = (kind: AddonRow['kind']) => data?.addons.filter(a => a.kind === kind) ?? [];

  function stateLine(a: AddonRow): string {
    const date = a.active ? fmtDate(a.active.endsAt, locale) : '';
    switch (a.state) {
      case 'renewing':
        return t('renewsOn', { date });
      case 'active':
        return t('activeUntil', { date });
      case 'cancelled_at_period_end':
        return t('cancelsOn', { date });
      case 'available':
        return t('price', { amount: money(a.priceMinor), days: data!.termDays });
      default:
        return t(`state.${a.state}Hint`);
    }
  }

  const row = (a: AddonRow) => {
    const canBuy =
      a.kind === 'ai_topup' ||
      a.state === 'available' ||
      a.state === 'failed' ||
      a.state === 'rejected' ||
      a.state === 'expired' ||
      a.state === 'refunded';
    return (
      <li
        key={a.sku}
        id={`addon-${a.sku}`}
        data-testid={`addon-${a.sku}`}
        data-state={a.state}
        className={`flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between ${
          focusSku === a.sku ? 'rounded-lg bg-primary/5 px-3' : ''
        }`}
      >
        <div className="flex min-w-0 gap-3">
          {a.previewImage && (
            // eslint-disable-next-line @next/next/no-img-element -- static asset from /public, fixed size
            <img
              src={a.previewImage}
              alt=""
              loading="lazy"
              width={96}
              height={64}
              className="h-16 w-24 shrink-0 rounded-md border border-border object-cover"
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{name(a)}</p>
              <span
                data-testid="addon-state"
                className={`rounded-full px-2 py-0.5 text-xs ${BADGE[a.state]}`}
              >
                {t(`state.${a.state}`)}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {locale === 'ar' ? a.descAr : a.descEn}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{stateLine(a)}</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {a.kind === 'feature' &&
            a.active &&
            (a.state === 'renewing' || a.state === 'cancelled_at_period_end') && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy === a.sku}
                onClick={() =>
                  void setRenewal(
                    a.sku,
                    a.state === 'cancelled_at_period_end' ? 'resume' : 'cancel'
                  )
                }
              >
                {a.state === 'cancelled_at_period_end' ? t('resume') : t('cancel')}
              </Button>
            )}
          {canBuy && (
            <Button
              size="sm"
              disabled={!data!.cardAvailable || busy === a.sku}
              onClick={() => void startBuy(a.sku)}
            >
              {a.state === 'active'
                ? t('buyAgain', { days: data!.termDays })
                : a.state === 'failed'
                  ? t('tryAgain')
                  : t('buy')}
            </Button>
          )}
          {canBuy && data!.instapayAvailable && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy === a.sku}
              onClick={() => void startInstapay(a.sku)}
            >
              {t('payInstapay')}
            </Button>
          )}
        </div>
      </li>
    );
  };

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {(returned || polling) && (
        <p role="status" className="mb-4 rounded-lg border border-border bg-card p-3 text-sm">
          {polling ? t('returnPending') : t('returnDone')}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}
        </p>
      )}
      {!data && !failed && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {data && (
        <div className="max-w-2xl space-y-6">
          {!data.cardAvailable && <p className="text-sm text-muted-foreground">{t('cardOff')}</p>}
          {insta && (
            <section
              aria-labelledby="addon-instapay-title"
              className="rounded-xl border border-border bg-card p-4"
              data-testid="addon-instapay"
            >
              <h2 id="addon-instapay-title" className="text-sm font-semibold">
                {t('instapayTitle', { name: name(insta) })}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('instapayHowItWorks')}</p>
              <div className="mt-3">
                <InstapayPanel
                  locale={locale}
                  instapay={{
                    available: true,
                    handle: insta.handle,
                    reference: insta.reference,
                    amountMinor: insta.amountMinor,
                    qrUrl: insta.qrUrl,
                    vat: null,
                    pendingClaims: 0,
                  }}
                />
              </div>
              <div className="mt-4">
                <InstapayReceiptForm
                  baseUrl={`/api/v1/stores/${storeId}/billing/receipts`}
                  submitBaseUrl={`${base}/${encodeURIComponent(insta.sku)}/instapay/receipts`}
                  reviewerNote={t('instapayReviewerNote')}
                  onSubmitted={() => {
                    setInsta(null);
                    toastSuccess(t('instapaySent'));
                    void load();
                  }}
                />
              </div>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setInsta(null)}>
                {t('instapayClose')}
              </Button>
            </section>
          )}
          {preview && (
            <section
              role="alertdialog"
              aria-labelledby="addon-confirm-title"
              className="rounded-xl border border-border bg-card p-4"
              data-testid="addon-confirm"
            >
              <h2 id="addon-confirm-title" className="text-sm font-semibold">
                {t('confirmTitle')}
              </h2>
              <p className="mt-1 text-sm">
                {t('confirmBody', {
                  amount: money(preview.totalMinor),
                  days: preview.termDays,
                  name: name(preview),
                })}
              </p>
              {preview.renews && (
                <p className="mt-1 text-sm" data-testid="addon-renews">
                  {t('confirmRenews', {
                    amount: money(preview.renewalMinor),
                    days: preview.renewsEveryDays,
                  })}
                </p>
              )}
              {preview.vatMinor > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('confirmVat', { vat: money(preview.vatMinor) })}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <Button disabled={busy !== null} onClick={() => void confirmBuy()}>
                  {t('confirmYes', { amount: money(preview.totalMinor) })}
                </Button>
                <Button variant="outline" disabled={busy !== null} onClick={() => setPreview(null)}>
                  {t('confirmNo')}
                </Button>
              </div>
            </section>
          )}
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">{t('featuresHeading')}</h2>
            <ul className="divide-y divide-border">{group('feature').map(row)}</ul>
            <p className="mt-3 text-xs text-muted-foreground" data-testid="addon-instapay-note">
              {t(data.instapayAvailable ? 'instapayNote' : 'instapayOff')}
            </p>
          </section>
          <section className="rounded-xl border border-border bg-card p-4" id="ai">
            <h2 className="text-sm font-semibold">{t('aiHeading')}</h2>
            <div className="mt-2" data-testid="ai-meter">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">
                  {t('aiMeterLeft', { remaining: data.ai.remaining })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('aiMeterUsed', { used: data.ai.used, cap: data.ai.cap })}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={t('aiMeterLeft', { remaining: data.ai.remaining })}
                aria-valuemin={0}
                aria-valuemax={data.ai.cap}
                aria-valuenow={Math.min(data.ai.used, data.ai.cap)}
                className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-2 rounded-full bg-primary"
                  style={{
                    width: `${data.ai.cap > 0 ? Math.min(100, Math.round((data.ai.used / data.ai.cap) * 100)) : 0}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('aiMeterSplit', { base: data.ai.baseCap, extra: data.ai.extra })}
              </p>
              {data.ai.packs.length > 0 && (
                <ul className="mt-1 text-xs text-muted-foreground" data-testid="ai-packs">
                  {data.ai.packs.map(p => (
                    <li key={`${p.sku}-${p.endsAt}`}>
                      {t('aiPackEnds', { name: name(p), date: fmtDate(p.endsAt, locale) })}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs font-medium">{t('aiBreakdownTitle')}</p>
              {data.ai.byFeature.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('aiBreakdownEmpty')}</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs" data-testid="ai-breakdown">
                  {data.ai.byFeature.map(f => (
                    <li key={f.feature} className="flex justify-between">
                      <span>{aiFeatureLabel(f.feature)}</span>
                      <span className="tabular-nums">{f.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">{t('aiResets')}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('aiBuyHint', { days: data.termDays })}
            </p>
            <ul className="divide-y divide-border">{group('ai_topup').map(row)}</ul>
          </section>
          <section
            className="rounded-xl border border-border bg-card p-4"
            data-testid="addon-history"
          >
            <h2 className="text-sm font-semibold">{t('historyHeading')}</h2>
            {history.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">{t('historyEmpty')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {history.map(h => (
                  <li
                    key={h.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{name(h)}</p>
                      <p className="text-xs text-muted-foreground">
                        {fmtDate(h.createdAt, locale)} · {money(h.amountMinor)} ·{' '}
                        {t(`history.${h.status}`)}
                        {h.termEnd && h.status === 'succeeded'
                          ? ` · ${t('historyUntil', { date: fmtDate(h.termEnd, locale) })}`
                          : ''}
                      </p>
                    </div>
                    {(h.status === 'succeeded' || h.status === 'refunded') && (
                      <Button variant="outline" size="sm" onClick={() => setReceipt(h)}>
                        {t('receipt')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {receipt && (
              <div className="mt-4" data-testid="addon-receipt">
                <EbdaBillingReceipt
                  charge={receipt}
                  planName={name(receipt)}
                  itemLabel={t('receiptItem')}
                  locale={locale}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setReceipt(null)}
                >
                  {t('receiptClose')}
                </Button>
              </div>
            )}
          </section>
        </div>
      )}
    </AdminLayout>
  );
}
