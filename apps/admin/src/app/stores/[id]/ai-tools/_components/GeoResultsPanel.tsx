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
import { Button, useToast } from '@force/ui';
import { apiGet } from '../../../../../lib/api';

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
      setError(err.message || 'Failed to load GEO results');
      setLoading(false);
      return;
    }
    setData(res ?? null);
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(`${label} copied`);
    } catch {
      // older browser fallback — silent
    }
  };

  if (loading) {
    return (
      <div className="mt-4 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        Loading GEO results…
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
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
        <h3 className="text-sm font-semibold text-foreground">
          GEO sweep results <span className="text-muted-foreground font-normal">/ النتائج</span>
        </h3>
        <Button onClick={load} size="sm" variant="outline">
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {/* LLMs.txt result */}
        <details className="rounded-md border border-border bg-background p-3 group">
          <summary className="cursor-pointer text-sm font-medium text-foreground flex items-center justify-between">
            <span>
              LLMs.txt{' '}
              {llmsLength > 0 ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 ml-1">
                  ✓ {llmsLength} chars
                </span>
              ) : (
                <span className="text-xs text-muted-foreground ml-1">empty</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground group-open:hidden">View</span>
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
                onClick={() => data.llmsTxt && copy(data.llmsTxt, 'LLMs.txt')}
              >
                Copy
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Not yet generated. Click <strong>Generate</strong> above to run the sweep.
            </p>
          )}
        </details>

        {/* Brand facts result */}
        <details className="rounded-md border border-border bg-background p-3 group">
          <summary className="cursor-pointer text-sm font-medium text-foreground flex items-center justify-between">
            <span>
              Brand facts{' '}
              {factsKeys > 0 ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 ml-1">
                  ✓ {factsKeys} keys
                </span>
              ) : (
                <span className="text-xs text-muted-foreground ml-1">empty</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground group-open:hidden">View</span>
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
                onClick={() => copy(JSON.stringify(data.brandFacts, null, 2), 'Brand facts JSON')}
              >
                Copy JSON
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Not yet generated. Click <strong>Generate</strong> above to run the sweep.
            </p>
          )}
        </details>

        {/* Citation copy fill summary */}
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-sm font-medium text-foreground mb-2">
            Citation copy{' '}
            <span className="text-muted-foreground font-normal">/ نسخة الاستشهاد</span>
          </p>
          <p className="text-3xl font-semibold text-primary">{fillPct}%</p>
          <p className="text-xs text-muted-foreground mt-1">
            {data.citationCopy.filledProducts} of {data.citationCopy.totalProducts} products filled
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Per-product values are visible on each product's edit page under{' '}
            <strong>Citation copy</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
