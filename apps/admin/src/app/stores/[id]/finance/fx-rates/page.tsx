'use client';

/**
 * FX Rate Registry — Admin page for multi-currency accounting.
 *
 * Allows store admins to record and view the exchange rates used for
 * non-EGP expense and journal entry conversions.
 *
 * Feature-gated: accounting.multi_currency (Enterprise).
 * If the feature is inactive, a friendly notice is shown instead.
 *
 * Rate meaning: 1 unit of the foreign currency = rate EGP.
 * Example: { currency: 'USD', rate: 50 } means 1 USD = 50 EGP.
 */

import { formatDate, intlLocaleForUi } from '@/lib/format';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { FeatureUpgradeGate } from '@/components/FeatureUpgradeGate';
import { apiGet, apiPost } from '@/lib/api';
import { ALLOWED_CURRENCIES, withNumerals } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

import { Button } from '@/components/ui/Button';
// ─── Types ────────────────────────────────────────────────────────────────────

interface FxRateEntry {
  id: string;
  currency: string;
  rate: number;
  rateDate: string;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const NON_BASE_CURRENCIES = ALLOWED_CURRENCIES.filter(c => c !== 'EGP');

// ─── Component ────────────────────────────────────────────────────────────────

export default function FxRatesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.fxRates');

  const [rates, setRates] = useState<FxRateEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [featureEnabled, setFeatureEnabled] = useState<boolean | null>(null);
  const [filterCurrency, setFilterCurrency] = useState('');
  // Bumped after a rate is saved: the load effect owns EVERY request, so the refetch reads the
  // CURRENT currency filter instead of the one captured by the submit handler (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  // Latest-request-wins: a slower response for the previous filter must not repaint its rows.
  const beginRequest = useLatestRequest();

  // Form state
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formRate, setFormRate] = useState('');
  const [formDate, setFormDate] = useState(todayIso());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState(false);

  useEffect(() => {
    if (!storeId) return;

    // Check feature
    apiGet<{ features: Record<string, boolean> }>(`/api/v1/stores/${storeId}/my-features`)
      .then(({ data }) => {
        setFeatureEnabled(data?.features?.['accounting.multi_currency'] === true);
      })
      .catch(() => setFeatureEnabled(false));
  }, [storeId]);

  useEffect(() => {
    if (!storeId || featureEnabled !== true) return;
    loadRates();
  }, [storeId, featureEnabled, filterCurrency, refreshKey]);

  async function loadRates() {
    const isLatest = beginRequest();
    setLoading(true);
    const url = `/api/v1/stores/${storeId}/finance/fx-rates${
      filterCurrency ? `?currency=${filterCurrency}` : ''
    }`;
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the rate array — reading `data?.data` double-unwrapped to
    // undefined and the table always rendered empty (#831 sweep).
    const { data } = await apiGet<FxRateEntry[]>(url);
    if (!isLatest()) return;
    setRates(data ?? []);
    setLoading(false);
  }

  async function handleSubmit() {
    setFormError(null);
    setFormSuccess(false);
    if (!formCurrency) {
      setFormError(t('errorCurrencyRequired'));
      return;
    }
    const rateNum = Number(formRate);
    if (!formRate || rateNum <= 0 || !isFinite(rateNum)) {
      setFormError(t('errorRatePositive'));
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await apiPost(`/api/v1/stores/${storeId}/finance/fx-rates`, {
        currency: formCurrency,
        rate: rateNum,
        rateDate: formDate || undefined,
      });
      if (error) {
        setFormError(error.message ?? t('errorSaveFailed'));
        return;
      }
      setFormSuccess(true);
      setFormRate('');
      setFormDate(todayIso());
      setRefreshKey(k => k + 1);
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const rateColumns: DataTableColumn<FxRateEntry>[] = [
    {
      header: t('colCurrency'),
      primaryOnMobile: true,
      cell: r => <span className="font-mono font-medium">{r.currency}</span>,
    },
    {
      header: t('colRate'),
      alignEnd: true,
      cell: r => <span className="font-mono">{Number(r.rate).toFixed(6)}</span>,
    },
    {
      header: t('colDate'),
      cell: r => <span className="text-muted-foreground">{formatDate(r.rateDate)}</span>,
    },
    {
      header: t('colRecorded'),
      cell: r => (
        <span className="text-muted-foreground text-xs">
          {new Date(r.createdAt).toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
  ];

  // Feature not active
  if (featureEnabled === false) {
    return <FeatureUpgradeGate featureKey="accounting.multi_currency" storeId={storeId} />;
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="max-w-3xl space-y-6">
        {/* ── Add Rate Form ─────────────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-muted/10 p-5 space-y-4">
          <p className="text-sm font-semibold">{t('recordNewRate')}</p>
          <p className="text-xs text-muted-foreground">
            {t('rateMeaning')}
            <br />
            {t('rateExample')}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('currencyLabel')}</span>
              <select
                value={formCurrency}
                onChange={e => setFormCurrency(e.target.value)}
                className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              >
                {NON_BASE_CURRENCIES.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">
                {t('rateLabel', { currency: formCurrency })}
              </span>
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={formRate}
                onChange={e => setFormRate(e.target.value)}
                placeholder={t('rateExample2')}
                className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm font-mono"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('rateDateLabel')}</span>
              <input
                type="date"
                value={formDate}
                onChange={e => setFormDate(e.target.value)}
                className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              />
            </label>
          </div>

          {/* Live EGP preview */}
          {formRate && Number(formRate) > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('ratePreview', {
                currency: formCurrency,
                rate: Number(formRate).toFixed(6),
                rate100: (Number(formRate) * 100).toFixed(3),
              })}
            </p>
          )}

          {formError && <p className="text-red-600 text-sm">{formError}</p>}
          {formSuccess && <p className="text-green-700 text-sm">{t('rateSaved')}</p>}

          <Button type="button" onClick={handleSubmit} disabled={submitting} variant="default">
            {submitting ? t('saving') : t('saveRate')}
          </Button>
        </div>

        {/* ── Rate History ──────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-sm font-semibold">{t('historyTitle')}</p>
            <select
              value={filterCurrency}
              onChange={e => setFilterCurrency(e.target.value)}
              className="border border-border rounded px-2 py-1 text-xs"
            >
              <option value="">{t('allCurrencies')}</option>
              {NON_BASE_CURRENCIES.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          ) : rates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noRates')}</p>
          ) : (
            <DataTable<FxRateEntry>
              ariaLabel={t('historyTitle')}
              columns={rateColumns}
              rows={rates}
              rowKey={r => r.id}
            />
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
