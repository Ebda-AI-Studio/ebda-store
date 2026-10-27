'use client';

import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import type { QrStatRow } from '../_hooks/useQr';

export function ScanStats({ rows }: { rows: QrStatRow[] | null }) {
  const t = useT('qr.stats');
  const locale = useLocale();
  return (
    <section aria-labelledby="qr-stats" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="qr-stats" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <span className="text-xs text-muted-foreground">{t('last30')}</span>
      </div>
      {!rows || rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map(r => {
            const name =
              r.kind === 'product' || r.kind === 'category'
                ? (locale === 'ar' && r.labelAr) || r.label || t(`kinds.${r.kind}`)
                : t(`kinds.${r.kind}`);
            return (
              <li
                key={`${r.kind}:${r.ref}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-foreground">
                  {name}
                  {(r.kind === 'product' || r.kind === 'category') && (
                    <span className="ms-2 text-xs text-muted-foreground">
                      {t(`kinds.${r.kind}`)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-medium tabular-nums text-foreground">
                  {t('scans', { count: r.scans })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
