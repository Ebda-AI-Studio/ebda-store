'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { withNumerals } from '@ebda/shared';
import { usePlanMeters, type MeterKey, type PlanMeter } from './usePlanMeters';
import { limitPct } from '../../lib/plan-limits';

/**
 * Warns BEFORE a plan limit bites: amber at >= 80%, red-toned at 100%, always with an upgrade CTA
 * to the billing page. It is an upgrade card, never an error: nothing here blocks the screen.
 * Numbers come from the same payloads the billing / AI meters read (see usePlanMeters).
 */
export function PlanLimitNotice({
  storeId,
  keys,
  className = 'mb-4',
}: {
  storeId: string;
  keys: readonly MeterKey[];
  className?: string;
}) {
  const meters = usePlanMeters(storeId, keys);
  if (meters.length === 0) return null;
  return (
    <div className={`space-y-3 ${className}`} data-testid="plan-limit-notices">
      {meters.map(m => (
        <NoticeCard key={m.key} storeId={storeId} meter={m} />
      ))}
    </div>
  );
}

function NoticeCard({ storeId, meter }: { storeId: string; meter: PlanMeter }) {
  const t = useT('planLimits');
  const full = meter.level === 'full';
  const num = (n: number) => n.toLocaleString(undefined, withNumerals());
  const body = t(`${meter.key}.${meter.level}Body` as Parameters<typeof t>[0], {
    used: num(meter.used),
    limit: num(meter.limit),
    window: meter.window ?? 'monthly',
  });
  const pct = limitPct(meter.used, meter.limit);
  return (
    <section
      role="status"
      data-testid={`plan-limit-${meter.key}`}
      data-level={meter.level}
      className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between ${
        full ? 'border-destructive/40 bg-destructive/5' : 'border-warning/40 bg-warning/10'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          {t(`${meter.key}.${meter.level}Title` as Parameters<typeof t>[0])}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        <div
          role="progressbar"
          aria-label={t(`${meter.key}.${meter.level}Title` as Parameters<typeof t>[0])}
          aria-valuemin={0}
          aria-valuemax={meter.limit}
          aria-valuenow={Math.min(meter.used, meter.limit)}
          className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full ${full ? 'bg-destructive' : 'bg-warning'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <Link
        href={`/stores/${storeId}/billing`}
        className={buttonVariants({ size: 'sm', className: 'shrink-0 self-start sm:self-center' })}
      >
        {t('upgradeCta')}
      </Link>
    </section>
  );
}
