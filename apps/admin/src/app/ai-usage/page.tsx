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
 *
 * Bilingual EN + AR throughout.
 */

import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet } from '../../lib/api';

// ── Types ─────────────────────────────────────────────────────────────

interface PlatformTotals {
  todayCount: number;
  monthCount: number;
  totalCached: number;
  totalUncached: number;
  cacheHitRatio: number;
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
}

interface SummaryResponse {
  platform: PlatformTotals;
  stores: StoreUsageRow[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

const PLAN_COLORS: Record<string, string> = {
  free: 'bg-muted text-muted-foreground',
  starter: 'bg-blue-100 text-blue-700',
  professional: 'bg-primary/10 text-primary',
  enterprise: 'bg-amber-100 text-amber-700',
};

function PlanBadge({ plan }: { plan: string }) {
  const cls = PLAN_COLORS[plan] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {planLabel(plan)}
    </span>
  );
}

function PctBar({ pct, warn }: { pct: number; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${warn || pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-amber-400' : 'bg-primary'}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className={`text-xs tabular-nums ${pct >= 90 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
        {pct}%
      </span>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────

function StatCard({
  label,
  labelAr,
  value,
  accent,
}: {
  label: string;
  labelAr: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground/60" dir="rtl">
        {labelAr}
      </p>
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
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Filters
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [featureFilter, setFeatureFilter] = useState<string>('all');

  const fetchData = useCallback(async () => {
    setError(false);
    try {
      const { data: payload, error: apiError } = await apiGet<{ data: SummaryResponse }>(
        '/api/v1/admin/super-admin/ai-usage/summary'
      );
      if (apiError || !payload?.data) {
        setError(true);
        return;
      }
      setData(payload.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Loading ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────

  if (error || !data) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        <p className="text-sm text-destructive">Failed to load platform AI usage data.</p>
        <p className="text-xs text-muted-foreground mt-1" dir="rtl">
          تعذّر تحميل بيانات الاستخدام على مستوى المنصة.
        </p>
        <button
          type="button"
          onClick={fetchData}
          className="mt-4 text-sm text-primary hover:underline"
        >
          Retry / إعادة المحاولة
        </button>
      </div>
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

  return (
    <>
      {/* ── Platform totals ─────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatCard
          label="AI Calls Today (platform)"
          labelAr="استدعاءات اليوم (المنصة)"
          value={platform.todayCount.toLocaleString()}
          accent
        />
        <StatCard
          label="Calls This Month (platform)"
          labelAr="استدعاءات الشهر (المنصة)"
          value={platform.monthCount.toLocaleString()}
        />
        <StatCard
          label="Cache Hit Ratio"
          labelAr="نسبة ضربات التخزين المؤقت"
          value={`${(platform.cacheHitRatio * 100).toFixed(1)}%`}
        />
        <StatCard
          label="Active Stores (filtered)"
          labelAr="المتاجر النشطة (مفلترة)"
          value={filteredStores.length.toLocaleString()}
        />
      </div>

      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="plan-filter">
            Plan / الخطة:
          </label>
          <select
            id="plan-filter"
            value={planFilter}
            onChange={e => setPlanFilter(e.target.value)}
            className="rounded-lg border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            aria-label="Filter by plan tier"
          >
            <option value="all">All plans / كل الخطط</option>
            {allPlans.map(p => (
              <option key={p} value={p}>
                {planLabel(p)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="feature-filter">
            Feature / الميزة:
          </label>
          <select
            id="feature-filter"
            value={featureFilter}
            onChange={e => setFeatureFilter(e.target.value)}
            className="rounded-lg border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            aria-label="Filter by AI feature"
          >
            <option value="all">All features / كل الميزات</option>
            {allFeatures.map(f => (
              <option key={f} value={f}>
                {f.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        {(planFilter !== 'all' || featureFilter !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setPlanFilter('all');
              setFeatureFilter('all');
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear filters / مسح الفلاتر ×
          </button>
        )}
      </div>

      {/* ── Per-store breakdown table ────────────────────────────────── */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">
            Per-store breakdown / توزيع الاستخدام لكل متجر
          </h2>
          <span className="text-xs text-muted-foreground">
            {filteredStores.length} stores / متجر
          </span>
        </div>

        {filteredStores.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No stores match the current filters.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Store / المتجر</th>
                  <th className="px-4 py-3 font-medium">Plan / الخطة</th>
                  <th className="px-4 py-3 font-medium text-end">Today / اليوم</th>
                  <th className="px-4 py-3 font-medium text-end">Month / الشهر</th>
                  <th className="px-4 py-3 font-medium">Daily cap % / اليومي</th>
                  <th className="px-4 py-3 font-medium">Monthly cap % / الشهري</th>
                  <th className="px-4 py-3 font-medium">Last call / آخر استدعاء</th>
                </tr>
              </thead>
              <tbody>
                {filteredStores.map(store => (
                  <tr key={store.storeId} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{store.name}</div>
                      <div className="text-xs text-muted-foreground">{store.slug}</div>
                    </td>
                    <td className="px-4 py-3">
                      <PlanBadge plan={store.plan} />
                    </td>
                    <td className="px-4 py-3 text-end font-bold tabular-nums text-foreground">
                      {store.today.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums text-muted-foreground">
                      {store.month.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <PctBar pct={store.dailyPct} />
                    </td>
                    <td className="px-4 py-3">
                      <PctBar pct={store.monthlyPct} warn={store.monthlyPct >= 80} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(store.lastCallAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ── Page export (wrapped in super_admin guard) ─────────────────────────

export default function PlatformAiUsagePage() {
  return (
    <AdminLayout
      title="AI Usage (platform) / استخدام الذكاء الاصطناعي (المنصة)"
      subtitle="Platform-wide AI call consumption across all stores."
      mode="super_admin"
    >
      <RequireSuperAdmin>
        <PlatformAiUsagePageInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
