'use client';

import { useT } from '@/i18n/useT';
import { formatPrice } from '@/lib/format';
import { isUntrackedForGuests } from '@/lib/guest-checkout';
import type { AbandonedCartStats } from './types';

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  /** Render `value` as an explanatory note rather than a figure. */
  muted?: boolean;
}

function StatCard({ label, value, sub, muted }: StatCardProps) {
  return (
    <div className="bg-card rounded-md border border-border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={
          typeof value === 'string' && muted
            ? 'mt-1 text-sm font-medium text-muted-foreground'
            : 'mt-1 text-2xl font-bold text-foreground'
        }
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

interface StatsGridProps {
  stats: AbandonedCartStats | null;
  /** The store takes guest orders — guest carts are never recorded. */
  guestCheckout?: boolean;
}

/**
 * Four-column summary cards at the top of the abandoned carts page.
 * Pure presentational component — receives already-fetched stats.
 */
export function StatsGrid({ stats, guestCheckout }: StatsGridProps) {
  const t = useT('abandonedCarts.stats');
  const tGuest = useT('components.guestCheckout');

  // Nothing recorded on a guest-checkout store = not tracked, not "0".
  if (isUntrackedForGuests(stats?.totalAbandoned ?? 0, guestCheckout)) {
    // STORE-QA-27: four tiles repeating the caveat read as a broken page. Dashes in the tiles, ONE sentence explaining why.
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label={t('totalAbandoned')} value="—" muted />
          <StatCard label={t('recovered')} value="—" muted />
          <StatCard label={t('recoveryRate')} value="—" muted />
          <StatCard label={t('recoveredRevenue')} value="—" muted />
        </div>
        <p className="text-xs text-muted-foreground">{tGuest('abandonedExplainer')}</p>
      </div>
    );
  }

  const sub = guestCheckout ? tGuest('registeredOnly') : undefined;
  // Recovery is not tracked (issue 2035): the API answers null, which is
  // unknown — shown as a note, never as 0 / 0% / 0 EGP.
  const notTracked = t('recoveryNotTracked');
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label={t('totalAbandoned')} value={stats?.totalAbandoned ?? 0} sub={sub} />
      <StatCard
        label={t('recovered')}
        value={stats?.totalRecovered ?? notTracked}
        muted={stats?.totalRecovered == null}
        sub={sub}
      />
      <StatCard
        label={t('recoveryRate')}
        value={stats?.recoveryRate != null ? `${stats.recoveryRate}%` : notTracked}
        muted={stats?.recoveryRate == null}
        sub={sub}
      />
      <StatCard
        label={t('recoveredRevenue')}
        value={stats?.recoveredRevenue != null ? formatPrice(stats.recoveredRevenue) : notTracked}
        muted={stats?.recoveredRevenue == null}
        sub={sub}
      />
    </div>
  );
}
