'use client';

/**
 * Add-ons — /stores/:id/billing/addons (SELF-SERVICE A8 + A9). The owner buys a feature outside the plan or a pack of
 * extra daily AI requests with a card. Two steps, never one click: preview shows the exact total and mints a
 * single-use token; only the explicit "Yes, charge" sends it (with an Idempotency-Key) and opens the hosted card page.
 * Nothing turns on in the browser: the entitlement arrives from the signed payment webhook.
 */
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { formatMoney } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPost, apiRequest } from '../../../../../lib/api';
import { fmtDate } from '../../../../../components/billing/format';
import { useT } from '../../../../../i18n/useT';

interface AddonRow {
  sku: string;
  kind: 'feature' | 'ai_topup';
  nameEn: string;
  nameAr: string;
  priceMinor: number;
  includedInPlan: boolean;
  active: { endsAt: string; cancelAtPeriodEnd: boolean } | null;
}
interface AddonsData {
  cardAvailable: boolean;
  termDays: number;
  addons: AddonRow[];
  ai: { baseCap: number; extra: number; cap: number; used: number; remaining: number };
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
}

export default function AddonsPage() {
  const storeId = useParams()?.id as string;
  const t = useT('addons');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const returned = useSearchParams()?.get('checkout') === 'return';
  const { success: toastSuccess, error: toastError } = useToast();
  const [data, setData] = useState<AddonsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/v1/stores/${storeId}/billing/addons`;
  const money = (minor: number) => formatMoney(minor, locale, { fixedDecimals: true });
  const name = (a: { nameEn: string; nameAr: string }) => (locale === 'ar' ? a.nameAr : a.nameEn);

  const load = useCallback(async () => {
    const r = await apiGet<AddonsData>(base);
    if (r.error || !r.data) return setFailed(true);
    setFailed(false);
    setData(r.data);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  async function startBuy(sku: string) {
    setBusy(sku);
    const r = await apiPost<Preview>(`${base}/preview`, { sku });
    setBusy(null);
    if (r.error || !r.data) return toastError(t('previewError'), r.error?.message);
    setPreview(r.data);
  }

  async function confirmBuy() {
    if (!preview) return;
    setBusy(preview.sku);
    const r = await apiRequest<{ redirectUrl: string }>(`${base}/checkout`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
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

  const group = (kind: AddonRow['kind']) => data?.addons.filter(a => a.kind === kind) ?? [];

  const row = (a: AddonRow) => (
    <li key={a.sku} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{name(a)}</p>
        <p className="text-xs text-muted-foreground">
          {a.includedInPlan
            ? t('includedInPlan')
            : a.active
              ? a.active.cancelAtPeriodEnd
                ? t('cancelsOn', { date: fmtDate(a.active.endsAt, locale) })
                : a.kind === 'feature'
                  ? t('renewsOn', { date: fmtDate(a.active.endsAt, locale) })
                  : t('activeUntil', { date: fmtDate(a.active.endsAt, locale) })
              : t('price', { amount: money(a.priceMinor), days: data!.termDays })}
        </p>
      </div>
      {!a.includedInPlan && (
        <div className="flex gap-2">
          {a.kind === 'feature' && a.active && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy === a.sku}
              onClick={() =>
                void setRenewal(a.sku, a.active!.cancelAtPeriodEnd ? 'resume' : 'cancel')
              }
            >
              {a.active.cancelAtPeriodEnd ? t('resume') : t('cancel')}
            </Button>
          )}
          {(a.kind === 'ai_topup' || !a.active) && (
            <Button
              size="sm"
              disabled={!data!.cardAvailable || busy === a.sku}
              onClick={() => void startBuy(a.sku)}
            >
              {a.active ? t('buyAgain', { days: data!.termDays }) : t('buy')}
            </Button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {returned && (
        <p role="status" className="mb-4 rounded-lg border border-border bg-card p-3 text-sm">
          {t('returnPending')}
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
          </section>
          <section className="rounded-xl border border-border bg-card p-4" id="ai">
            <h2 className="text-sm font-semibold">{t('aiHeading')}</h2>
            <p className="mt-1 text-sm">
              {t('aiToday', { used: data.ai.used, cap: data.ai.cap, remaining: data.ai.remaining })}
              {data.ai.extra > 0 && ` ${t('aiExtra', { extra: data.ai.extra })}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('aiBuyHint', { days: data.termDays })}
            </p>
            <ul className="divide-y divide-border">{group('ai_topup').map(row)}</ul>
          </section>
        </div>
      )}
    </AdminLayout>
  );
}
