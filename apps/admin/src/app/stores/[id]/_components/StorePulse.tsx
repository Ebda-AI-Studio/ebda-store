'use client';

import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { cn } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { formatPrice } from '../../../../lib/format';
import {
  PULSE_PERIODS,
  type PulsePeriod,
  type PulseStats,
  type PulseSalesPoint,
  type PulseTopProduct,
  type PulseUnpaid,
  type Slice,
  type StorePulse as PulseData,
} from '../_hooks/useStorePulse';
import { sparkBars, toDelta, type Delta } from './pulse-format';

const CARD = 'rounded-xl border bg-card shadow-sm';
const count = (n: number) => n.toLocaleString('en-US');

/* ---------- period switch ---------- */

// pq-allow(unused-export): test seam, imported by StorePulse.test.tsx
export function PeriodSwitch({
  value,
  onChange,
}: {
  value: PulsePeriod;
  onChange: (p: PulsePeriod) => void;
}) {
  const t = useT('stores.dashboard.pulse');
  return (
    <div
      role="radiogroup"
      aria-label={t('periodLabel')}
      className="inline-flex max-w-full overflow-x-auto rounded-xl border bg-muted/50 p-1"
    >
      {PULSE_PERIODS.map(p => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={cn(
            'min-h-10 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            value === p
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t(`period.${p}`)}
        </button>
      ))}
    </div>
  );
}

/* ---------- delta pill ---------- */

function DeltaPill({ delta, label }: { delta: Delta | null; label: string }) {
  const t = useT('stores.dashboard.pulse');
  if (!delta) return null;
  const tone =
    delta.tone === 'up'
      ? 'bg-success/10 text-success-ink'
      : delta.tone === 'down'
        ? 'bg-destructive/10 text-destructive-ink'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      data-testid="delta"
      data-tone={delta.tone}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
        tone
      )}
    >
      {delta.tone !== 'flat' && (
        <svg
          aria-hidden="true"
          className={cn('h-3 w-3', delta.tone === 'down' && 'rotate-180')}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 10V2M2.5 5.5L6 2l3.5 3.5" />
        </svg>
      )}
      <span dir="ltr">{delta.tone === 'flat' ? '0%' : `${delta.percent}%`}</span>
      <span className="sr-only">
        {t(`deltaSr.${delta.tone}`, { percent: delta.percent })} {label}
      </span>
    </span>
  );
}

/* ---------- sparkline ---------- */

function Spark({ points, label }: { points: PulseSalesPoint[]; label: string }) {
  const bars = sparkBars(points.map(p => p.revenue));
  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-20 w-full items-end gap-[3px] sm:w-56"
      dir="ltr"
    >
      {bars.map((h, i) => (
        <div
          key={points[i].date}
          title={`${points[i].date}: ${formatPrice(points[i].revenue)}`}
          className={cn(
            'min-h-[3px] flex-1 rounded-sm',
            i === bars.length - 1 ? 'bg-primary' : 'bg-primary/35'
          )}
          style={{ height: `${Math.max(4, h * 100)}%` }}
        />
      ))}
    </div>
  );
}

/* ---------- section error ---------- */

function SliceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT('stores.dashboard.pulse');
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
    >
      <p className="text-sm text-destructive-ink">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

/* ---------- sales hero ---------- */

// pq-allow(unused-export): test seam, imported by StorePulse.test.tsx
export function SalesHero({
  stats,
  sales,
  period,
  onRetry,
  onShare,
}: {
  stats: Slice<PulseStats>;
  sales: Slice<PulseSalesPoint[]>;
  period: PulsePeriod;
  onRetry: () => void;
  onShare: () => void;
}) {
  const t = useT('stores.dashboard.pulse');
  if (stats === 'error') return <SliceError message={t('statsFailed')} onRetry={onRetry} />;
  if (stats === null) {
    return (
      <div className={cn(CARD, 'p-5 sm:p-6')} aria-busy="true" data-testid="hero-skeleton">
        <div className="h-4 w-28 force-skeleton" />
        <div className="mt-3 h-10 w-48 force-skeleton" />
        <div className="mt-3 h-4 w-64 max-w-full force-skeleton" />
      </div>
    );
  }
  const empty = stats.totalOrders === 0 && stats.totalRevenue === 0;
  const delta = toDelta(stats.revenueChange);
  const periodLabel = t(`period.${period}`);
  const points = Array.isArray(sales) ? sales : [];
  return (
    <div className={cn(CARD, 'p-5 sm:p-6')} data-testid="sales-hero">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">
            {t('salesLabel')} · {periodLabel}
          </p>
          <p className="mt-1 text-4xl font-bold text-foreground" dir="ltr">
            {formatPrice(stats.totalRevenue)}
          </p>
          {empty ? (
            <div className="mt-3" data-testid="hero-empty">
              <p className="text-sm text-muted-foreground">{t('emptyBody')}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={onShare}>
                {t('emptyCta')}
              </Button>
            </div>
          ) : (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <DeltaPill delta={delta} label={t('vsPrevious')} />
              <span>
                {t(`sentence.${delta?.tone ?? 'unknown'}`, {
                  percent: delta?.percent ?? 0,
                  orders: count(stats.totalOrders),
                })}
              </span>
            </p>
          )}
        </div>
        {!empty && points.length > 1 && <Spark points={points} label={t('sparkLabel')} />}
      </div>
    </div>
  );
}

/* ---------- KPI row ---------- */

function Kpi({
  label,
  value,
  hint,
  delta,
  href,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: Delta | null;
  href?: string;
  testId: string;
}) {
  const t = useT('stores.dashboard.pulse');
  const body = (
    <>
      <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
      <p className="mt-1 text-2xl font-bold text-foreground" dir="ltr">
        {value}
      </p>
      <div className="mt-1 flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
        {delta ? <DeltaPill delta={delta} label={t('vsPrevious')} /> : null}
        {hint ? <span>{hint}</span> : null}
      </div>
    </>
  );
  const cls = cn(CARD, 'block p-4');
  return href ? (
    <Link href={href} data-testid={testId} className={cn(cls, 'transition hover:border-primary')}>
      {body}
    </Link>
  ) : (
    <div data-testid={testId} className={cls}>
      {body}
    </div>
  );
}

// pq-allow(unused-export): test seam, imported by StorePulse.test.tsx
export function KpiRow({
  stats,
  unpaid,
  storeId,
}: {
  stats: Slice<PulseStats>;
  unpaid: Slice<PulseUnpaid>;
  storeId: string;
}) {
  const t = useT('stores.dashboard.pulse');
  if (stats === null) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="force-skeleton h-24 rounded-xl" />
        ))}
      </div>
    );
  }
  // The hero already shows the stats failure with a retry; a second banner would only repeat it.
  if (stats === 'error') return null;
  const conv = stats.conversionRate;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        testId="kpi-orders"
        label={t('orders')}
        value={count(stats.totalOrders)}
        delta={toDelta(stats.ordersChange)}
        href={`/stores/${storeId}/orders`}
      />
      <Kpi
        testId="kpi-aov"
        label={t('avgOrder')}
        value={formatPrice(stats.averageOrderValue)}
        hint={t('avgOrderHint')}
      />
      <Kpi
        testId="kpi-conversion"
        label={t('conversion')}
        value={conv === null ? '—' : `${conv}%`}
        hint={conv === null ? t('conversionNone') : t('conversionHint')}
      />
      {unpaid === 'error' ? (
        <Kpi testId="kpi-unpaid" label={t('unpaid')} value="—" hint={t('unpaidFailed')} />
      ) : unpaid === null ? (
        <div className="force-skeleton h-24 rounded-xl" />
      ) : (
        <Kpi
          testId="kpi-unpaid"
          label={t('unpaid')}
          value={count(unpaid.orders)}
          hint={unpaid.orders > 0 ? formatPrice(unpaid.revenue) : t('unpaidNone')}
          href={`/stores/${storeId}/orders?paymentStatus=pending`}
        />
      )}
    </div>
  );
}

/* ---------- top products ---------- */

export function TopProductsCard({
  products,
  storeId,
  onRetry,
}: {
  products: Slice<PulseTopProduct[]>;
  storeId: string;
  onRetry: () => void;
}) {
  const t = useT('stores.dashboard.pulse');
  const ar = typeof document !== 'undefined' && document.documentElement.lang.startsWith('ar');
  return (
    <section className={cn(CARD, 'p-5')} aria-label={t('topProducts')}>
      <h2 className="mb-3 font-semibold text-foreground">{t('topProducts')}</h2>
      {products === 'error' ? (
        <SliceError message={t('topProductsFailed')} onRetry={onRetry} />
      ) : products === null ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="force-skeleton h-9 rounded-lg" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div data-testid="top-empty">
          <p className="text-sm text-muted-foreground">{t('topProductsEmpty')}</p>
          <Link
            href={`/stores/${storeId}/products/new`}
            className="mt-2 inline-block text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
          >
            {t('topProductsEmptyCta')}
          </Link>
        </div>
      ) : (
        <ol className="divide-y">
          {products.map((p, i) => (
            <li key={p.id}>
              <Link
                href={`/stores/${storeId}/products/${p.id}`}
                className="flex min-h-12 items-center gap-3 py-2 hover:text-primary-ink"
              >
                <span className="w-5 text-sm font-semibold text-muted-foreground" dir="ltr">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {ar && p.nameAr ? p.nameAr : p.name}
                </span>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  {t('sold', { count: count(p.quantity) })}
                </span>
                <span className="text-sm font-semibold text-foreground" dir="ltr">
                  {formatPrice(p.revenue)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ---------- composed block ---------- */

export function StorePulseBlock({
  pulse,
  period,
  onPeriod,
  onRetry,
  storeId,
  storeUrl,
}: {
  pulse: PulseData;
  period: PulsePeriod;
  onPeriod: (p: PulsePeriod) => void;
  onRetry: () => void;
  storeId: string;
  storeUrl: string;
}) {
  const t = useT('stores.dashboard.pulse');
  const { success, error } = useToast();
  const share = async () => {
    try {
      await navigator.clipboard.writeText(storeUrl);
      success(t('linkCopied'));
    } catch {
      error(t('linkCopyFailed'));
    }
  };
  return (
    <section aria-label={t('title')} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-foreground">{t('title')}</h2>
        <PeriodSwitch value={period} onChange={onPeriod} />
      </div>
      <SalesHero
        stats={pulse.stats}
        sales={pulse.sales}
        period={period}
        onRetry={onRetry}
        onShare={() => void share()}
      />
      <KpiRow stats={pulse.stats} unpaid={pulse.unpaid} storeId={storeId} />
    </section>
  );
}
