'use client';

/**
 * Revision history (Phase 1 API): newest first, cursor-paged; "Restore"
 * publishes a NEW revision with that content (history is never rewritten).
 * Every data has a UI: this is the surface for `store_page_revisions`.
 */
import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { ConfirmDialog } from './ConfirmDialog';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../lib/api';

interface Rev {
  rev: number;
  status: 'draft' | 'published' | 'archived';
  note: string | null;
  createdAt: string;
  publishedAt: string | null;
  publishedBy?: string | null;
  publishedByName?: string | null;
}

const DAY_MS = 86_400_000;

/** Calendar days between `when` and `now` in the viewer's local time (0 = today, 1 = yesterday). */
function dayDiff(when: Date, now: Date): number {
  const a = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / DAY_MS);
}

export function RevisionsPanel({
  storeId,
  pageKey = 'home',
  headRev,
  onRestored,
}: {
  storeId: string;
  pageKey?: string;
  headRev: number;
  onRestored: () => void;
}) {
  const t = useT('builder.revisions');
  const locale = useLocale();
  const base = `/api/v1/admin/stores/${storeId}/builder/pages/${pageKey}`;
  const [rows, setRows] = useState<Rev[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState(false);
  // The version waiting for the in-app confirmation (never `window.confirm`).
  const [asking, setAsking] = useState<number | null>(null);

  const load = useCallback(
    async (after?: number) => {
      const res = await apiGet<{ revisions: Rev[]; nextCursor: number | null }>(
        `${base}/revisions?limit=20${after ? `&cursor=${after}` : ''}`
      );
      if (res.error || !res.data) return setError(true);
      setRows(prev => (after ? [...prev, ...res.data!.revisions] : res.data!.revisions));
      setCursor(res.data.nextCursor);
    },
    [base]
  );

  /** "Today 3:40 pm" / "Yesterday 9:10 am" / "3 Nov 2026, 3:40 pm", in the active locale. */
  const when = (iso: string): string => {
    const date = new Date(iso);
    const time = new Intl.DateTimeFormat(locale, {
      timeStyle: 'short',
      numberingSystem: 'latn',
    }).format(date);
    const diff = dayDiff(date, new Date());
    if (diff === 0) return `${t('today')} ${time}`;
    if (diff === 1) return `${t('yesterday')} ${time}`;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      numberingSystem: 'latn',
    }).format(date);
  };

  useEffect(() => {
    void load();
  }, [load, headRev]);

  const restore = async (rev: number) => {
    setAsking(null);
    setBusy(rev);
    const res = await apiPost(`${base}/rollback`, { targetRev: rev, baseRev: headRev });
    setBusy(null);
    if (res.error) return setError(true);
    onRestored();
  };

  return (
    <div
      className="h-full overflow-y-auto p-4"
      data-testid="revisions-panel"
      data-setting-id="builder.history"
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive-ink">
          {t('error')}
        </p>
      )}
      {rows.length === 0 && !error && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      <ol className="space-y-2">
        {rows.map(r => (
          <li key={r.rev} className="rounded-lg border border-border p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {t('rev', { rev: r.rev })} ·{' '}
                <span
                  className={
                    r.status === 'published' ? 'text-primary-ink' : 'text-muted-foreground'
                  }
                >
                  {t(`status.${r.status}`)}
                </span>
              </span>
              {r.status === 'archived' && (
                <Button
                  variant="link"
                  size="sm"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setAsking(r.rev)}
                >
                  {busy === r.rev ? t('restoring') : t('restore')}
                </Button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {when(r.publishedAt ?? r.createdAt)}
            </p>
            {r.publishedBy && (
              <p className="text-xs text-muted-foreground">
                {/* the name is isolated (FSI/PDI) so a Latin name never scrambles the Arabic line */}
                {r.publishedByName
                  ? t('by.named', { name: `\u2068${r.publishedByName}\u2069` })
                  : t('by.removed')}
              </p>
            )}
            {/* one-line summary from the row's own data: a restore says which version, else the status */}
            <p className="text-xs text-foreground" data-testid={`rev-summary-${r.rev}`}>
              {r.note?.startsWith('rollback to rev ')
                ? t('restoredFrom', { rev: r.note.slice('rollback to rev '.length) })
                : r.publishedAt
                  ? t('summary.published')
                  : t('summary.draft')}
            </p>
          </li>
        ))}
      </ol>
      {asking !== null && (
        <ConfirmDialog
          title={t('confirmRestoreTitle')}
          body={t('confirmRestore', { rev: asking })}
          confirmLabel={t('restoreConfirmButton')}
          tone="primary"
          onConfirm={() => void restore(asking)}
          onCancel={() => setAsking(null)}
        />
      )}
      {cursor && (
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={() => void load(cursor)}
          className="mt-3"
        >
          {t('more')}
        </Button>
      )}
    </div>
  );
}
