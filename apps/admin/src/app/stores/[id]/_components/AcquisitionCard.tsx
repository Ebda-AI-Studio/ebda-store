import { useT } from '@/i18n/useT';
import type { Store } from './types';

interface AcquisitionCardProps {
  acquisition: Store['owner']['acquisition'];
}

/**
 * Super-admin only: how this store's owner found Ebda (first-touch utm / fbclid / landing page),
 * captured at signup when they accepted the cookie banner. Part of Ebda's own ads tracking
 * (docs/ebda/ads-tracking.md).
 */
export function AcquisitionCard({ acquisition }: AcquisitionCardProps) {
  const t = useT('stores.dashboard.acquisition');
  const a = acquisition?.attribution;
  const rows: Array<[string, string | undefined]> = a
    ? [
        [t('source'), a.utm_source],
        [t('medium'), a.utm_medium],
        [t('campaign'), a.utm_campaign],
        [t('content'), a.utm_content],
        [t('term'), a.utm_term],
        [t('fbclid'), a.fbclid ? t('present') : undefined],
        [t('landing'), a.landing],
        [t('referrer'), a.referrer],
        [t('firstSeen'), new Date(a.first_seen).toISOString().slice(0, 10)],
      ]
    : [];
  const shown = rows.filter(([, v]) => !!v);
  return (
    <div className="rounded-md border bg-card shadow-sm" data-testid="acquisition-card">
      <div className="border-b p-4">
        <h2 className="font-semibold text-foreground">{t('title')}</h2>
      </div>
      <div className="p-6">
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
            {shown.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-medium text-foreground" dir="ltr">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
