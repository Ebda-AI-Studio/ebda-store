'use client';

import { useT } from '@/i18n/useT';

export interface ActiveMethodRow {
  id: string;
  name: string;
  enabled: boolean;
  /** Turning ON needs a saved, tested connection; a gateway without one shows the reason instead of a switch. */
  blockedReason?: string | null;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
}

/**
 * "شغّال دلوقتي": the answer to the merchant's first question on this page (what can my customers pay with right
 * now?) with an on/off switch per method, before any credential form (UX:PS-1). Provider connections stay as
 * collapsed cards below; this strip never edits credentials.
 */
export function ActiveMethodsStrip({ rows }: { rows: ActiveMethodRow[] }) {
  const t = useT('paymentSettings.strip');
  const enabledCount = rows.filter(r => r.enabled).length;

  return (
    <section
      aria-labelledby="payment-active-title"
      className="mb-6 rounded-md border border-border bg-card p-4 shadow-sm"
      data-testid="payment-active-strip"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="payment-active-title" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {enabledCount === 0 ? t('none') : t('count', { count: enabledCount })}
        </p>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {rows.map(row => (
          <li key={row.id} className="flex min-h-11 items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{row.name}</p>
              {row.blockedReason && !row.enabled && (
                <p className="text-xs text-muted-foreground">{row.blockedReason}</p>
              )}
            </div>
            <label className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {row.enabled ? t('on') : t('off')}
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={row.name}
                checked={row.enabled}
                disabled={row.busy || (!row.enabled && Boolean(row.blockedReason))}
                onChange={e => row.onToggle(e.target.checked)}
                className="h-5 w-9 cursor-pointer accent-primary disabled:cursor-not-allowed"
              />
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
