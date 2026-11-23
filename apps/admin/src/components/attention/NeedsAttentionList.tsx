'use client';

import Link from 'next/link';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { buttonVariants } from '@/components/ui/Button';
import { useAttention } from '../../hooks/useAttention';
import { AttentionBadge } from './AttentionBadge';

/** "Needs your attention" at the top of the Settings overview. Renders nothing while nothing is wrong. */
export function NeedsAttentionList({ storeId }: { storeId: string }) {
  const t = useT('attention');
  const lang: 'ar' | 'en' = useLocale() === 'ar' ? 'ar' : 'en';
  const { items } = useAttention(storeId);
  if (items.length === 0) return null;
  const actions = items.filter(i => i.severity === 'action');
  const infos = items.filter(i => i.severity === 'info');
  const href = (section: string) =>
    section === 'settings' ? `/stores/${storeId}/settings` : `/stores/${storeId}/${section}`;

  const row = (i: (typeof items)[number], isAction: boolean) => (
    <li
      key={i.id}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`attention-item-${i.id}`}
    >
      <div className="min-w-0">
        <p className="font-medium text-foreground">{i.title[lang]}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{i.message[lang]}</p>
      </div>
      <Link
        href={href(i.section)}
        className={buttonVariants({
          variant: isAction ? 'default' : 'outline',
          className: 'shrink-0',
        })}
      >
        {isAction ? t('fix') : t('view')}
      </Link>
    </li>
  );

  return (
    <section
      aria-labelledby="settings-attention-title"
      className="rounded-xl border border-warning/40 bg-warning/10 p-4 sm:p-5"
      data-testid="needs-attention-list"
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 id="settings-attention-title" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <AttentionBadge count={actions.length} />
      </div>
      {actions.length > 0 && <ul className="space-y-2">{actions.map(i => row(i, true))}</ul>}
      {infos.length > 0 && (
        <div className={actions.length > 0 ? 'mt-4' : ''}>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">{t('info')}</h3>
          <ul className="space-y-2">{infos.map(i => row(i, false))}</ul>
        </div>
      )}
    </section>
  );
}
