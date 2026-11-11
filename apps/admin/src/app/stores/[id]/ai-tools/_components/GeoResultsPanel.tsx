'use client';

/**
 * GeoResultsPanel — shows the CURRENT populated outputs of the three
 * GEO sweeps (LLMs.txt, brand facts JSON, citation-copy fill rate) so
 * the merchant can see what the AI actually filled in.
 *
 * Wires to GET /api/v1/stores/:storeId/ai/results/geo. Refresh button
 * re-fetches.
 */

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiGet } from '../../../../../lib/api';
import { useT } from '@/i18n/useT';

interface GeoResults {
  llmsTxt: string | null;
  brandFacts: Record<string, unknown> | null;
  citationCopy: {
    totalProducts: number;
    filledProducts: number;
    fillRate: number;
  };
}

interface Props {
  storeId: string;
  /** Bump this number to trigger a refetch — parent does it when a sweep completes. */
  refreshTrigger?: number;
}

export function GeoResultsPanel({ storeId, refreshTrigger }: Props) {
  const t = useT('aiTools.geoResults');
  const [data, setData] = useState<GeoResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success: toastSuccess } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: res, error: err } = await apiGet<GeoResults>(
      `/api/v1/stores/${storeId}/ai/results/geo`
    );
    if (err) {
      setError(err.message || t('errorFailed'));
      setLoading(false);
      return;
    }
    setData(res ?? null);
    setLoading(false);
  }, [storeId, t]);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(t('copiedToast', { label }));
    } catch {
      // older browser fallback — silent
    }
  };

  if (loading) {
    return (
      <div className="mt-4 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        {t('loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-ink">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const llmsLength = data.llmsTxt?.length ?? 0;
  const factsKeys = data.brandFacts ? Object.keys(data.brandFacts).length : 0;
  const fillPct = Math.round(data.citationCopy.fillRate * 100);

  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <Button onClick={load} size="sm" variant="outline">
          {t('refresh')}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {/* LLMs.txt result */}
        <details className="rounded-md border border-border bg-background p-3 group">
          <summary className="cursor-pointer text-sm font-medium text-foreground flex items-center justify-between">
            <span>
              {t('llmsTxt.label')}{' '}
              {llmsLength > 0 ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 ms-1">
                  ✓ {llmsLength} {t('llmsTxt.charsSuffix')}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground ms-1">{t('empty')}</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground group-open:hidden">{t('view')}</span>
          </summary>
          {data.llmsTxt ? (
            <div className="mt-3">
              <pre className="whitespace-pre-wrap break-words text-xs bg-muted/40 p-2 rounded max-h-64 overflow-y-auto">
                {data.llmsTxt}
              </pre>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => data.llmsTxt && copy(data.llmsTxt, t('llmsTxt.label'))}
              >
                {t('copy')}
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              {t.rich('notGenerated', { b: chunks => <strong>{chunks}</strong> })}
            </p>
          )}
        </details>

        {/* Brand facts result */}
        <details className="rounded-md border border-border bg-background p-3 group">
          <summary className="cursor-pointer text-sm font-medium text-foreground flex items-center justify-between">
            <span>
              {t('brandFacts.label')}{' '}
              {factsKeys > 0 ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 ms-1">
                  ✓ {factsKeys} {t('brandFacts.keysSuffix')}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground ms-1">{t('empty')}</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground group-open:hidden">{t('view')}</span>
          </summary>
          {data.brandFacts ? (
            <div className="mt-3">
              <pre className="whitespace-pre-wrap break-words text-xs bg-muted/40 p-2 rounded max-h-64 overflow-y-auto">
                {JSON.stringify(data.brandFacts, null, 2)}
              </pre>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() =>
                  copy(JSON.stringify(data.brandFacts, null, 2), t('brandFacts.jsonLabel'))
                }
              >
                {t('copyJson')}
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              {t.rich('notGenerated', { b: chunks => <strong>{chunks}</strong> })}
            </p>
          )}
        </details>

        {/* Citation copy fill summary */}
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-sm font-medium text-foreground mb-2">{t('citationCopy.label')}</p>
          <p className="text-3xl font-semibold text-primary">{fillPct}%</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('citationCopy.filledOfTotal', {
              filled: data.citationCopy.filledProducts,
              total: data.citationCopy.totalProducts,
            })}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {t.rich('citationCopy.hint', { b: chunks => <strong>{chunks}</strong> })}
          </p>
        </div>
      </div>
    </div>
  );
}
