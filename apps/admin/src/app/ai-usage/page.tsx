'use client';

/**
 * Super-admin platform-wide AI usage view — /ai-usage
 *
 * Shows platform-level AI call aggregation across ALL stores:
 *   - Platform totals (today, this month, cached ratio)
 *   - Per-store breakdown: store name, plan tier, today/month usage,
 *     % of cap, last call timestamp
 *   - Sorted by today's count descending (highest consumers first)
 *   - Filters: by plan tier, by feature type
 *   - Date range picker (default: this month)
 *
 * Route guard: super_admin only — store_admins are redirected to 404.
 * Data: GET /api/v1/super-admin/ai-usage/summary
 */

import { Button } from '@/components/ui/Button';
import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet } from '../../lib/api';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { useT } from '../../i18n/useT';
import { PageState } from '@/components/PageState';
import { formatSpend } from '@/lib/ai-spend';
import { withNumerals } from '@ebda/shared';
import { intlLocaleForUi } from '@/lib/format';
import { tierPlanLabel } from '@/lib/plan-labels';
import { useLocale } from 'next-intl';

// ── Types ─────────────────────────────────────────────────────────────

interface PlatformTotals {
  todayCount: number;
  monthCount: number;
  totalCached: number;
  totalUncached: number;
  cacheHitRatio: number;
  /** Spend this month in MICROS of the billing currency (1_000_000 = 1 unit). */
  monthCostMicros: number;
  /** Billable calls this month whose model had NO configured rate. These
   *  contribute NOTHING to monthCostMicros, so a non-zero value means the
   *  spend figure is a FLOOR — never present it as the true total. */
  monthUnpricedCalls: number;
  /** False when AI_MODEL_RATES is unset — lets the UI explain an empty column
   *  instead of showing a confident zero. */
  ratesConfigured: boolean;
}

interface StoreUsageRow {
  storeId: string;
  slug: string;
  name: string;
  plan: string;
  today: number;
  month: number;
  dailyCap: number;
  monthlyCap: number;
  dailyPct: number;
  monthlyPct: number;
  lastCallAt: string | null;
  featureCounts: Record<string, number>;
  monthCostMicros: number;
  monthUnpricedCalls: number;
}

interface SummaryResponse {
  platform: PlatformTotals;
  stores: StoreUsageRow[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(intlLocaleForUi('en-GB'), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function planLabel(plan: string, locale: 'ar' | 'en'): string {
  return tierPlanLabel(plan, locale);
}

const PLAN_COLORS: Record<string, string> = {
  free: 'bg-muted text-muted-foreground',
  starter: 'bg-blue-100 text-blue-700',
  professional: 'bg-primary/10 text-primary-ink',
  enterprise: 'bg-warning/10 text-warning-ink',
};

function PlanBadge({ plan }: { plan: string }) {
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const cls = PLAN_COLORS[plan] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {planLabel(plan, locale)}
    </span>
  );
}

function PctBar({ pct, warn }: { pct: number; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${warn || pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-warning' : 'bg-primary'}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span
        className={`text-xs tabular-nums ${pct >= 90 ? 'text-destructive-ink font-medium' : 'text-muted-foreground'}`}
      >
        {pct}%
      </span>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${accent ? 'text-primary' : 'text-foreground'}`}
      >
        {value}
      </p>
    </div>
  );
}

// ── Page inner (needs RequireSuperAdmin wrapper) ───────────────────────

function PlatformAiUsagePageInner() {
  const t = useT('aiUsage.platform');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Filters
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [featureFilter, setFeatureFilter] = useState<string>('all');

  const fetchData = useCallback(async () => {
    setError(false);
    try {
      // apiGet already unwraps the API's `{ success, data }` envelope, so
      // `payload` IS the SummaryResponse — do NOT read `payload.data` (that
      // double-unwrap was always undefined → the page showed "Failed to load"
      // on every successful response).
      const { data: payload, error: apiError } = await apiGet<SummaryResponse>(
        '/api/v1/admin/super-admin/ai-usage/summary'
      );
      if (apiError || !payload) {
        setError(true);
        return;
      }
      setData(payload);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Loading / error (one wrapper, CU-1) ─────────────────────────────

  if (loading || error || !data) {
    return (
      <PageState
        loading={loading}
        error={error || !data ? t('loadError') : null}
        onRetry={() => {
          setLoading(true);
          fetchData();
        }}
      >
        {null}
      </PageState>
    );
  }

  // ── Derived filter values ────────────────────────────────────────────

  // Collect all feature keys across stores
  const allFeatures = Array.from(
    new Set(data.stores.flatMap(s => Object.keys(s.featureCounts)))
  ).sort();

  // All plan tiers present in data
  const allPlans = Array.from(new Set(data.stores.map(s => s.plan))).sort();

  // Apply filters
  const filteredStores = data.stores.filter(s => {
    if (planFilter !== 'all' && s.plan !== planFilter) return false;
    if (featureFilter !== 'all' && !(featureFilter in s.featureCounts)) return false;
    return true;
  });

  const { platform } = data;

  const columns: DataTableColumn<StoreUsageRow>[] = [
    {
      header: t('table.store'),
      primaryOnMobile: true,
      cell: store => (
        <div>
          <div className="font-medium text-foreground">{store.name}</div>
          <div className="text-xs text-muted-foreground">{store.slug}</div>
        </div>
      ),
    },
    {
      header: t('table.plan'),
      mobileBadge: true,
      cell: store => <PlanBadge plan={store.plan} />,
    },
    {
      header: t('table.today'),
      alignEnd: true,
      cell: store => (
        <span className="font-bold tabular-nums text-foreground">
          {store.today.toLocaleString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.month'),
      alignEnd: true,
      cell: store => (
        <span className="tabular-nums text-muted-foreground">
          {store.month.toLocaleString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.dailyCapPct'),
      cell: store => <PctBar pct={store.dailyPct} />,
    },
    {
      header: t('table.monthlyCapPct'),
      cell: store => <PctBar pct={store.monthlyPct} warn={store.monthlyPct >= 80} />,
    },
    {
      header: t('table.spendMonth'),
      alignEnd: true,
      cell: store => (
        <div className="tabular-nums">
          <div className="font-medium text-foreground">{formatSpend(store.monthCostMicros)}</div>
          {store.monthUnpricedCalls > 0 && (
            <div className="text-xs text-warning-ink" title={t('unpricedTooltip')}>
              +{store.monthUnpricedCalls.toLocaleString(undefined, withNumerals())}{' '}
              {t('unpricedRowSuffix')}
            </div>
          )}
        </div>
      ),
    },
    {
      header: t('table.lastCall'),
      hideOnMobile: true,
      cell: store => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(store.lastCallAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      {/* ── Platform totals ─────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatCard
          label={t('statCards.today')}
          value={platform.todayCount.toLocaleString(undefined, withNumerals())}
          accent
        />
        <StatCard
          label={t('statCards.thisMonth')}
          value={platform.monthCount.toLocaleString(undefined, withNumerals())}
        />
        <StatCard
          label={t('statCards.cacheHitRatio')}
          value={
            platform.totalCached + platform.totalUncached === 0
              ? '—'
              : `${(platform.cacheHitRatio * 100).toFixed(1)}%`
          }
        />
        <StatCard label={t('statCards.monthSpend')} value={formatSpend(platform.monthCostMicros)} />
        <StatCard
          label={t('statCards.activeStores')}
          value={filteredStores.length.toLocaleString(undefined, withNumerals())}
        />
      </div>

      {/* Spend is only as truthful as the rate table behind it. Say so loudly
          rather than letting a confident-looking number stand in for one that
          was never actually priced. */}
      {!platform.ratesConfigured ? (
        <div className="mb-6 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-ink">
          <strong>{t('noRatesConfiguredTitle')}</strong> {t('noRatesConfiguredBody')}
        </div>
      ) : platform.monthUnpricedCalls > 0 ? (
        <div className="mb-6 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-ink">
          <strong>
            {t('unpricedCallsTitle', {
              count: platform.monthUnpricedCalls.toLocaleString(undefined, withNumerals()),
            })}
          </strong>{' '}
          {t('unpricedCallsBody')}
        </div>
      ) : null}

      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="plan-filter">
            {t('filters.planLabel')}:
          </label>
          <select
            id="plan-filter"
            value={planFilter}
            onChange={e => setPlanFilter(e.target.value)}
            className="rounded-lg border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            aria-label={t('filters.filterByPlan')}
          >
            <option value="all">{t('filters.allPlans')}</option>
            {allPlans.map(p => (
              <option key={p} value={p}>
                {planLabel(p, locale)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="feature-filter">
            {t('filters.featureLabel')}:
          </label>
          <select
            id="feature-filter"
            value={featureFilter}
            onChange={e => setFeatureFilter(e.target.value)}
            className="rounded-lg border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            aria-label={t('filters.filterByFeature')}
          >
            <option value="all">{t('filters.allFeatures')}</option>
            {allFeatures.map(f => (
              <option key={f} value={f}>
                {t.has(`featureNames.${f}`) ? t(`featureNames.${f}`) : t('featureNames.other')}
              </option>
            ))}
          </select>
        </div>

        {(planFilter !== 'all' || featureFilter !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              setPlanFilter('all');
              setFeatureFilter('all');
            }}
            className="text-muted-foreground"
          >
            {t('filters.clear')}
          </Button>
        )}
      </div>

      {/* ── Per-store breakdown table ────────────────────────────────── */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('perStoreBreakdown')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('storesCount', { count: filteredStores.length })}
          </span>
        </div>

        <DataTable<StoreUsageRow>
          ariaLabel={t('perStoreBreakdown')}
          columns={columns}
          rows={filteredStores}
          rowKey={store => store.storeId}
          emptyState={
            <div className="px-6 py-8 text-center">
              <p className="text-sm text-muted-foreground">{t('table.empty')}</p>
            </div>
          }
        />
      </div>
    </>
  );
}

// ── Page export (wrapped in super_admin guard) ─────────────────────────

export default function PlatformAiUsagePage() {
  const t = useT('aiUsage.platform');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <PlatformAiUsagePageInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
