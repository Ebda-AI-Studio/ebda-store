'use client';

/**
 * Revision history (Phase 1 API): newest first, cursor-paged; "Restore"
 * publishes a NEW revision with that content (history is never rewritten).
 * Every data has a UI: this is the surface for `store_page_revisions`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useFormatter } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../lib/api';

interface Rev {
  rev: number;
  status: 'draft' | 'published' | 'archived';
  note: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export function RevisionsPanel({
  storeId,
  headRev,
  onRestored,
}: {
  storeId: string;
  headRev: number;
  onRestored: () => void;
}) {
  const t = useT('builder.revisions');
  const format = useFormatter();
  const base = `/api/v1/admin/stores/${storeId}/builder/pages/home`;
  const [rows, setRows] = useState<Rev[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState(false);

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
    if (!window.confirm(t('confirmRestore', { rev }))) return;
    setBusy(rev);
    const res = await apiPost(`${base}/rollback`, { targetRev: rev, baseRev: headRev });
    setBusy(null);
    if (res.error) return setError(true);
    onRestored();
  };

  return (
    <div className="h-full overflow-y-auto p-4" data-testid="revisions-panel">
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {t('error')}
        </p>
      )}
      {rows.length === 0 && !error && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      <ol className="space-y-2">
        {rows.map(r => (
          <li key={r.rev} className="rounded-lg border border-border p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {t('rev', { rev: r.rev })} · {t(`status.${r.status}`)}
              </span>
              {r.status === 'archived' && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void restore(r.rev)}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-40"
                >
                  {busy === r.rev ? t('restoring') : t('restore')}
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {format.dateTime(new Date(r.publishedAt ?? r.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          </li>
        ))}
      </ol>
      {cursor && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          className="mt-3 text-sm text-primary hover:underline"
        >
          {t('more')}
        </button>
      )}
    </div>
  );
}
