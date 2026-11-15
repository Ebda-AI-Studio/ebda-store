'use client';

/**
 * Undo history of AI "replace existing" runs (Ruling AITOOLS-4). Two views of the same data:
 *  - `runs`: the AI tools page, one line per bulk run with "Undo this run" and the changes behind it;
 *  - `product`: the product page, the changes still undoable on that product.
 * The server restores a value only while it still holds what the AI wrote; a field edited since is refused and said so here.
 */
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiGet, apiPost } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { useT } from '@/i18n/useT';

interface Run {
  jobId: string;
  tool: string;
  userId: string | null;
  at: string;
  changed: number;
  undone: number;
}
interface Change {
  id: string;
  jobId: string | null;
  tool: string;
  entityKind: string;
  productName: string | null;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  userId: string | null;
  createdAt: string;
  restoredAt: string | null;
}
interface UndoResult {
  restored: number;
  refused: Array<{ id: string; reason: string }>;
}

const clip = (v: string | null, n = 80) => {
  const s = v ?? '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

type Props =
  | { storeId: string; mode: 'runs'; refreshTrigger?: number; onRestored?: () => void }
  | { storeId: string; mode: 'product'; productId: string; onRestored?: () => void };

export function ReplaceHistory(props: Props) {
  const { storeId, onRestored } = props;
  const t = useT('aiTools.undo');
  const { user } = useAuth();
  const toast = useToast();
  const [runs, setRuns] = useState<Run[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const productId = props.mode === 'product' ? props.productId : null;
  const refreshTrigger = props.mode === 'runs' ? props.refreshTrigger : undefined;
  const base = `/api/v1/stores/${storeId}/ai`;

  const loadChanges = useCallback(
    async (q: string) => {
      const { data, error: err } = await apiGet<Change[]>(`${base}/replace-backups?${q}`);
      if (err) setError(err.message || t('errorLoad'));
      else setChanges(data ?? []);
    },
    [base, t]
  );

  const load = useCallback(async () => {
    setError(null);
    if (productId) {
      await loadChanges(`productId=${encodeURIComponent(productId)}`);
    } else {
      const { data, error: err } = await apiGet<Run[]>(`${base}/replace-runs`);
      if (err) setError(err.message || t('errorLoad'));
      else setRuns(data ?? []);
    }
    setLoading(false);
  }, [base, productId, loadChanges, t]);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  async function undo(key: string, scope: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    const { data, error: err } = await apiPost<UndoResult>(`${base}/replace-backups/undo`, scope);
    setBusy(null);
    if (err || !data) {
      setError(err?.message || t('errorUndo'));
      return;
    }
    if (data.refused.length > 0) setError(t('refused', { count: data.refused.length }));
    if (data.restored > 0) {
      toast.success(t('restored', { count: data.restored }));
      onRestored?.();
    }
    await load();
    if (openRun) await loadChanges(`jobId=${encodeURIComponent(openRun)}`);
  }

  const toggleRun = async (jobId: string) => {
    if (openRun === jobId) {
      setOpenRun(null);
      return;
    }
    setOpenRun(jobId);
    setChanges([]);
    await loadChanges(`jobId=${encodeURIComponent(jobId)}&includeRestored=true`);
  };

  const who = (id: string | null) => (id && id === user?.id ? t('you') : t('team'));
  const toolLabel = (k: string) => t(`tools.${k}`);
  const fieldLabel = (k: string) => t(`fields.${k}`);

  const changeList = (
    <ul className="divide-y divide-border rounded-lg border bg-card">
      {changes.map(c => (
        <li
          key={c.id}
          className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              {c.productName ?? t('storeItem')} · {fieldLabel(c.field)}
            </p>
            {c.field !== 'categories' && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span>{t('before')}: </span>
                <bdi>{clip(c.previousValue)}</bdi>
                <span> → {t('after')}: </span>
                <bdi>{clip(c.newValue)}</bdi>
              </p>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {toolLabel(c.tool)} · {formatDateTime(c.createdAt)} · {who(c.userId)}
            </p>
          </div>
          {c.restoredAt ? (
            <span className="text-xs text-muted-foreground">{t('undone')}</span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy !== null}
              onClick={() => undo(c.id, { ids: [c.id] })}
            >
              {t('undoChange')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );

  // The product page shows nothing until there is something to undo.
  if (props.mode === 'product' && !loading && changes.length === 0 && !error) return null;

  return (
    <section
      className="mt-6 rounded-xl border bg-card p-5 shadow-sm"
      aria-labelledby={`undo-${props.mode}-title`}
      data-testid="replace-history"
    >
      <h2 id={`undo-${props.mode}-title`} className="text-lg font-semibold text-foreground">
        {props.mode === 'runs' ? t('title') : t('productTitle')}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {props.mode === 'runs' ? t('intro') : t('productIntro')}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive-ink">
          {error}
        </p>
      )}

      {props.mode === 'product' ? (
        <div className="mt-3 space-y-3">
          {changeList}
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy !== null}
            onClick={() => undo('product', { productId })}
          >
            {t('undoProduct')}
          </Button>
        </div>
      ) : loading ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>
      ) : runs.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {runs.map(r => {
            const left = r.changed - r.undone;
            return (
              <li key={r.jobId}>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-foreground">{toolLabel(r.tool)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(r.at)} · {who(r.userId)} ·{' '}
                      {t('runCounts', { changed: r.changed, undone: r.undone })}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => toggleRun(r.jobId)}
                    >
                      {openRun === r.jobId ? t('hideChanges') : t('showChanges')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      disabled={busy !== null || left === 0}
                      onClick={() => undo(r.jobId, { jobId: r.jobId })}
                    >
                      {t('undoRun')}
                    </Button>
                  </div>
                </div>
                {openRun === r.jobId && <div className="mt-2">{changeList}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
