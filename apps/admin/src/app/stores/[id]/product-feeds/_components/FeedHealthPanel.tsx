'use client';

import { withNumerals } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';
import type { FeedHealth, FeedLang } from './types';

const num = (n: number) => n.toLocaleString(undefined, withNumerals());

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className="force-stat-card">
      <p className="text-sm text-muted-foreground" dir="auto">
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold ${tone === 'warn' && value > 0 ? 'text-destructive-ink' : 'text-foreground'}`}
      >
        {num(value)}
      </p>
    </div>
  );
}

/** Summary numbers, parts notice, and the list of items that are excluded or could be better, each with its fix. */
export function FeedHealthPanel({
  health,
  lang,
  onRefresh,
}: {
  health: FeedHealth;
  lang: FeedLang;
  onRefresh: () => void;
}) {
  const t = useT('productFeeds.health');
  const tTop = useT('productFeeds');
  const clean = health.items > 0 && health.excluded === 0 && health.warnings === 0;

  return (
    <section className="space-y-4" aria-labelledby="feed-health-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="feed-health-title" className="text-base font-semibold text-foreground" dir="auto">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground" dir="auto">
            {t('language', { lang: tTop(`language.${lang}`) })}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
          {t('refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label={t('items')} value={health.items} />
        <Stat label={t('products')} value={health.products} />
        <Stat label={t('excluded')} value={health.excluded} tone="warn" />
        <Stat label={t('warnings')} value={health.warnings} />
      </div>

      {health.products === 0 ? (
        <p
          className="bg-card rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
          dir="auto"
        >
          {t('empty')}
        </p>
      ) : clean ? (
        <p
          className="bg-card rounded-lg border border-border p-4 text-sm text-foreground"
          dir="auto"
        >
          {t('allGood')}
        </p>
      ) : null}

      {health.parts > 1 && (
        <p
          className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground"
          dir="auto"
        >
          {tTop('parts', { count: health.parts })}
        </p>
      )}
      {health.scanTruncated && (
        <p className="text-sm text-destructive-ink" dir="auto">
          {t('scanTruncated')}
        </p>
      )}

      <ul className="space-y-1 text-xs text-muted-foreground" dir="auto">
        <li>
          {t('notPublished', {
            draft: health.notPublished.draft,
            archived: health.notPublished.archived,
            wholesale: health.notPublished.wholesaleOnly,
          })}
        </li>
        <li>{health.shippingFlat ? t('shippingFlat') : t('shippingVaries')}</li>
        <li>{t('imageNote')}</li>
      </ul>

      {health.issues.length > 0 && (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <h3
            className="px-4 py-3 text-sm font-semibold text-foreground border-b border-border"
            dir="auto"
          >
            {t('issuesTitle')}
          </h3>
          <ul className="divide-y divide-border">
            {health.issues.map((i, idx) => (
              <li
                key={`${i.id}-${i.code}-${idx}`}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
              >
                <span
                  className={`shrink-0 self-start rounded-full px-2 py-0.5 text-xs font-medium ${
                    i.kind === 'excluded'
                      ? 'bg-destructive/10 text-destructive-ink'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {i.kind === 'excluded' ? t('excludedBadge') : t('warningBadge')}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground" dir="auto">
                    {i.title}
                  </p>
                  <p className="text-sm text-muted-foreground" dir="auto">
                    {t(`code.${i.code}`)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {health.issuesTruncated && (
            <p
              className="px-4 py-3 text-sm text-muted-foreground border-t border-border"
              dir="auto"
            >
              {t('truncatedIssues', { count: health.issues.length })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
