'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useNeedsAction, type NeedCount } from '../_hooks/useNeedsAction';
import { useAttention } from '../../../../hooks/useAttention';
import { useLocale } from 'next-intl';

interface Tile {
  key: string;
  label: string;
  href: string;
  count: NeedCount;
}

/**
 * "محتاج تصرّف": the first thing on the dashboard (UX:D-2). One tile per job waiting on the merchant. A tile with
 * nothing waiting is not shown; if every count failed there is one error tile with a retry (UX:D-3), never a row
 * of zeros. A count that is still loading renders a placeholder of the same size so the page does not jump.
 */
export function NeedsAction({ storeId }: { storeId: string }) {
  const t = useT('stores.dashboard.needsAction');
  const { counts, reload } = useNeedsAction(storeId);
  // Money + setup blockers (failed payments, unconfirmed InstaPay, billing due, domain DNS...): the same
  // feed as the Settings badges and the bell, so there is one source and no duplicated rules.
  const lang: 'ar' | 'en' = useLocale() === 'ar' ? 'ar' : 'en';
  const attention = useAttention(storeId);
  const base = `/stores/${storeId}`;

  const tiles: Tile[] = [
    {
      key: 'orders',
      label: t('orders'),
      href: `${base}/orders?status=pending`,
      count: counts.newOrders,
    },
    { key: 'stock', label: t('lowStock'), href: `${base}/stock/inventory`, count: counts.lowStock },
    { key: 'returns', label: t('returns'), href: `${base}/returns`, count: counts.pendingReturns },
    { key: 'reviews', label: t('reviews'), href: `${base}/reviews`, count: counts.pendingReviews },
    { key: 'seo', label: t('seoMissing'), href: `${base}/seo`, count: counts.seoMissing },
  ];

  const loading = tiles.some(x => x.count === null);
  // 'error' tiles belong to a feature the plan may not include: hide them. All four failing means a real outage.
  const allFailed = tiles.every(x => x.count === 'error');
  const open = tiles.filter(x => typeof x.count === 'number' && x.count > 0);
  const blockers = attention.items.filter(i => i.severity === 'action');

  if (allFailed) {
    return (
      <section
        aria-label={t('title')}
        className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
          <p className="text-sm text-destructive-ink">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t('retry')}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t('title')} className="mb-6">
      <h2 className="mb-3 font-semibold text-foreground">{t('title')}</h2>
      {loading && open.length === 0 && blockers.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="force-skeleton h-20 rounded-xl" />
          ))}
        </div>
      ) : open.length === 0 && blockers.length === 0 ? (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          {t('allClear')}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {open.map(tile => (
            <Link
              data-ui="tile"
              key={tile.key}
              href={tile.href}
              className="flex min-h-20 flex-col justify-center rounded-xl border border-primary/30 bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
            >
              <span className="text-3xl font-bold tracking-tight text-foreground">
                {tile.count as number}
              </span>
              <span className="mt-1 text-sm text-muted-foreground">{tile.label}</span>
            </Link>
          ))}
          {blockers.map(i => (
            <Link
              data-ui="tile"
              key={i.id}
              href={`${base}/${i.section}`}
              data-testid={`needs-action-${i.id}`}
              className="flex min-h-20 flex-col justify-center rounded-xl border border-warning/50 bg-warning/10 p-4 shadow-sm transition hover:border-warning hover:shadow-md"
            >
              {typeof i.count === 'number' && (
                <span className="text-3xl font-bold tracking-tight text-foreground">{i.count}</span>
              )}
              <span className="mt-1 text-sm font-medium text-foreground">{i.title[lang]}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
