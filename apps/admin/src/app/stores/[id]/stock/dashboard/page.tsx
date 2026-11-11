'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@ebda/ui';
import { formatPrice } from '@/lib/format';

import { Button } from '@/components/ui/Button';
// ─── Types ────────────────────────────────────────────────────────────────────

interface FinanceDashboard {
  thisMonth: { revenue: number; expenses: number; net: number };
  cash: { code: string; nameEn: string; balance: number }[];
  stockValue: number;
  balanceSheet: { totalAssets: number; totalLiabilities: number; totalEquity: number };
}

interface ProductsResponse {
  products: unknown[];
  meta: { total: number };
}

interface LowStockResponse {
  products: unknown[] | null;
}

type BackordersArray = unknown[];

interface SuggestionListResponse {
  data: unknown[];
  meta?: { total: number };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StockDashboardPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.dashboard');
  const tc = useT('common');
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const { success: toastSuccess, error: toastError } = useToast();
  const [lowStockScanning, setLowStockScanning] = useState(false);

  // On-demand low-stock digest (mirrors the reorder/deadstock "Re-scan now").
  // The scan claims each product atomically, so a double click or an overlap
  // with the 6-hourly cron cannot email the same digest twice.
  async function handleLowStockScan() {
    if (lowStockScanning) return;
    setLowStockScanning(true);
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/stock/low-stock-scan/run-now`,
      {}
    );
    setLowStockScanning(false);
    if (apiError) toastError(t('lowStockScanFailed'), apiError.message || '');
    else toastSuccess(t('lowStockScanQueued'));
  }

  const [dashboard, setDashboard] = useState<FinanceDashboard | null>(null);
  const [onHandCount, setOnHandCount] = useState<number | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [backorderCount, setBackorderCount] = useState<number | null>(null);
  const [reorderCount, setReorderCount] = useState<number | null>(null);
  const [deadstockCount, setDeadstockCount] = useState<number | null>(null);
  // Per-card error state — fixes the original "Database operation failed"
  // bug where a single failing fetch (e.g. /finance/dashboard for a store
  // with no chart of accounts) blanked the entire page. Now each card
  // shows its own "Couldn't load" message + the other cards continue
  // to render whatever they successfully fetched.
  const [financeErr, setFinanceErr] = useState<string | null>(null);
  const [onHandErr, setOnHandErr] = useState<string | null>(null);
  const [lowStockErr, setLowStockErr] = useState<string | null>(null);
  const [backorderErr, setBackorderErr] = useState<string | null>(null);
  const [reorderErr, setReorderErr] = useState<string | null>(null);
  const [deadstockErr, setDeadstockErr] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;

    // Finance dashboard (stock value) — most likely culprit when the
    // store hasn't seeded Chart of Accounts yet. Failure here used to
    // blank the whole page via setError(); now it's contained.
    apiGet<FinanceDashboard>(`/api/v1/stores/${storeId}/finance/dashboard`).then(
      ({ data, error: e }) => {
        if (e) setFinanceErr(e.message);
        else if (data) setDashboard(data);
      }
    );

    // On-hand SKUs (active products count)
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?status=active&limit=1`).then(
      ({ data, error: e }) => {
        if (e) setOnHandErr(e.message);
        else if (data) setOnHandCount(data.meta?.total ?? data.products?.length ?? 0);
      }
    );

    // Low-stock SKUs
    apiGet<LowStockResponse>(`/api/v1/stores/${storeId}/analytics/low-stock`).then(
      ({ data, error: e }) => {
        if (e) setLowStockErr(e.message);
        else if (data) setLowStockCount(data.products?.length ?? 0);
      }
    );

    // Open backorders
    apiGet<BackordersArray>(`/api/v1/stores/${storeId}/backorders`).then(({ data, error: e }) => {
      if (e) setBackorderErr(e.message);
      else if (data) setBackorderCount(data.length);
    });

    // Reorder suggestions (open)
    apiGet<SuggestionListResponse>(
      `/api/v1/stores/${storeId}/stock/reorder-suggestions?status=open&perPage=1`
    ).then(({ data, error: e }) => {
      if (e) setReorderErr(e.message);
      else if (data) {
        setReorderCount(data.meta?.total ?? data.data?.length ?? 0);
      }
    });

    // Dead-stock flags (open)
    apiGet<SuggestionListResponse>(
      `/api/v1/stores/${storeId}/stock/deadstock-flags?status=open&perPage=1`
    ).then(({ data, error: e }) => {
      if (e) setDeadstockErr(e.message);
      else if (data) {
        setDeadstockCount(data.meta?.total ?? data.data?.length ?? 0);
      }
    });
  }, [storeId]);

  // Show the loading state ONLY while we're waiting on the first response
  // from any of the 6 fetches. Once one comes back (success OR error),
  // render the grid — empty cards show their own loading/error states.
  const anyResponded =
    dashboard !== null ||
    onHandCount !== null ||
    lowStockCount !== null ||
    backorderCount !== null ||
    reorderCount !== null ||
    deadstockCount !== null ||
    financeErr !== null ||
    onHandErr !== null ||
    lowStockErr !== null ||
    backorderErr !== null ||
    reorderErr !== null ||
    deadstockErr !== null;

  if (!anyResponded) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  // Per-card values: `—` when the fetch failed, `…` while waiting,
  // the actual number when resolved. No card silently disappears.
  const kpis = [
    {
      label: t('stockValue'),
      value: dashboard ? formatPrice(dashboard.stockValue) : financeErr ? '—' : '…',
      highlight: true,
      errMsg: financeErr,
    },
    {
      label: t('onHandSkus'),
      value: onHandCount !== null ? String(onHandCount) : onHandErr ? '—' : '…',
      errMsg: onHandErr,
    },
    {
      label: t('lowStockSkus'),
      value: lowStockCount !== null ? String(lowStockCount) : lowStockErr ? '—' : '…',
      warn: lowStockCount !== null && lowStockCount > 0,
      errMsg: lowStockErr,
    },
    {
      label: t('openBackorders'),
      value: backorderCount !== null ? String(backorderCount) : backorderErr ? '—' : '…',
      errMsg: backorderErr,
    },
    {
      label: t('reorderSuggestions'),
      value: reorderCount !== null ? String(reorderCount) : reorderErr ? '—' : '…',
      warn: reorderCount !== null && reorderCount > 0,
      href: `/stores/${storeId}/stock/reorder`,
      errMsg: reorderErr,
    },
    {
      label: t('deadStockCount'),
      value: deadstockCount !== null ? String(deadstockCount) : deadstockErr ? '—' : '…',
      warn: deadstockCount !== null && deadstockCount > 0,
      href: `/stores/${storeId}/stock/deadstock`,
      errMsg: deadstockErr,
    },
  ];

  return (
    <AdminLayout title={t('title')}>
      {isSuperAdmin && (
        <div className="mb-4 flex justify-end max-w-5xl">
          <Button
            type="button"
            onClick={handleLowStockScan}
            disabled={lowStockScanning}
            variant="outline"
            size="sm"
          >
            {lowStockScanning ? tc('loading') : t('lowStockScanNow')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl">
        {kpis.map(kpi => {
          const card = (
            <div key={kpi.label} className="rounded-md border border-border bg-card p-5 space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {kpi.label}
              </p>
              <p
                className={[
                  'text-2xl font-semibold font-mono',
                  kpi.highlight ? 'text-primary' : '',
                  kpi.warn ? 'text-warning-ink' : '',
                  kpi.errMsg ? 'text-muted-foreground' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {kpi.value}
              </p>
              {kpi.errMsg && (
                <p className="text-xs text-destructive-ink truncate" title={kpi.errMsg}>
                  {t('couldntLoad')}
                </p>
              )}
              {kpi.href && !kpi.errMsg && (
                <p className="text-xs text-primary underline underline-offset-2 cursor-pointer">
                  {t('viewAll')}
                </p>
              )}
            </div>
          );

          if (kpi.href) {
            return (
              <button
                key={kpi.label}
                type="button"
                onClick={() => router.push(kpi.href!)}
                className="text-start w-full"
              >
                {card}
              </button>
            );
          }

          return card;
        })}
      </div>
    </AdminLayout>
  );
}
