'use client';

import { useT } from '@/i18n/useT';
import { formatPercent, type GscTopQuery } from './types';
import { withNumerals } from '@ebda/shared';

interface GscTopQueriesListProps {
  topQueries: GscTopQuery[];
}

/** Top-queries list from the latest ingested day — mirrors
 * `PromptResultsList`'s card + divided-list styling. */
export function GscTopQueriesList({ topQueries }: GscTopQueriesListProps) {
  const t = useT('answerEngine.gsc');

  if (topQueries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noTopQueries')}</p>;
  }

  return (
    <div className="bg-card rounded-md border border-border shadow-sm overflow-hidden">
      <h2 className="text-lg font-semibold text-foreground px-6 pt-6">{t('topQueriesTitle')}</h2>
      <ul className="divide-y divide-border mt-3">
        {topQueries.map(q => (
          <li key={q.query} className="px-6 py-3 flex items-center justify-between gap-3">
            <p className="text-sm text-foreground min-w-0 truncate" dir="auto">
              {q.query}
            </p>
            <p className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
              {q.clicks.toLocaleString(undefined, withNumerals())} {t('clicks').toLowerCase()} ·{' '}
              {q.impressions.toLocaleString(undefined, withNumerals())}{' '}
              {t('impressions').toLowerCase()}
              {q.impressions > 0 && ` · ${formatPercent(q.clicks / q.impressions)}`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
