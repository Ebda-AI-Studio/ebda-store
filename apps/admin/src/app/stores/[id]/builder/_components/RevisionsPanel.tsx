'use client';

/**
 * Revision history (Phase 1 API): newest first, cursor-paged; "Restore"
 * publishes a NEW revision with that content (history is never rewritten).
 * Every data has a UI: this is the surface for `store_page_revisions`.
 */
import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useState } from 'react';
import { useFormatter } from 'next-intl';
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
  const format = useFormatter();
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
                  className={r.status === 'published' ? 'text-primary' : 'text-muted-foreground'}
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
              {format.dateTime(new Date(r.publishedAt ?? r.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
            {r.publishedBy && (
              <p className="text-xs text-muted-foreground">
                {/* the name is isolated (FSI/PDI) so a Latin name never scrambles the Arabic line */}
                {r.publishedByName
                  ? t('by.named', { name: `\u2068${r.publishedByName}\u2069` })
                  : t('by.removed')}
              </p>
            )}
            {r.note?.startsWith('rollback to rev ') && (
              <p className="text-xs text-muted-foreground">
                {t('restoredFrom', { rev: r.note.slice('rollback to rev '.length) })}
              </p>
            )}
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
