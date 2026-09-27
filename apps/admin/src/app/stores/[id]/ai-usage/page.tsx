'use client';

/**
 * AI Usage page — /stores/:id/ai-usage
 *
 * Detailed view: quota summary card (AiUsageSummaryCard) + full paginated
 * log of every AI call with date, feature, tokens, and cached status.
 *
 * The summary card is the same component embedded at the top of the AI Tools
 * page — DRY, single source of truth for quota numbers.
 *
 * Data: GET /api/v1/stores/:storeId/ai/usage/summary + /ai/usage/log
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useAuth } from '../../../../lib/auth';
import { apiGet } from '../../../../lib/api';
import { AiUsageSummaryCard } from '../../../../components/ai/AiUsageSummaryCard';
import { DataTable, type DataTableColumn } from '../../../../components/mobile/DataTable';
import { useT } from '../../../../i18n/useT';

// ── Types ─────────────────────────────────────────────────────────────

interface UsageRow {
  id: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cachedHit: boolean;
  createdAt: string;
}

interface LogData {
  rows: UsageRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatFeature(feature: string): string {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Main page ──────────────────────────────────────────────────────────

export default function AiUsagePage() {
  const params = useParams();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;
  const t = useT('aiUsage');

  const [log, setLog] = useState<LogData | null>(null);
  const [logError, setLogError] = useState(false);
  const [logLoading, setLogLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchLog = useCallback(
    async (p: number) => {
      if (!isAuthenticated || !storeId) return;
      setLogError(false);
      try {
        const logRes = await apiGet<{ data: LogData }>(
          `/api/v1/stores/${storeId}/ai/usage/log?page=${p}&pageSize=20`
        );
        if (logRes.error) {
          setLogError(true);
          return;
        }
        setLog(logRes.data?.data ?? null);
      } catch {
        setLogError(true);
      } finally {
        setLogLoading(false);
      }
    },
    [isAuthenticated, storeId]
  );

  useEffect(() => {
    fetchLog(page);
  }, [fetchLog, page]);

  // ── Render ───────────────────────────────────────────────────────────

  const columns: DataTableColumn<UsageRow>[] = [
    {
      header: t('table.date'),
      primaryOnMobile: true,
      cell: row => (
        <span className="text-foreground whitespace-nowrap">{formatDate(row.createdAt)}</span>
      ),
    },
    {
      header: t('table.feature'),
      cell: row => <span className="text-foreground">{formatFeature(row.feature)}</span>,
    },
    {
      header: t('table.tokens'),
      cell: row => (
        <span className="text-muted-foreground tabular-nums">
          {row.inputTokens + row.outputTokens > 0
            ? (row.inputTokens + row.outputTokens).toLocaleString()
            : '—'}
        </span>
      ),
    },
    {
      header: t('table.status'),
      mobileBadge: true,
      cell: row =>
        row.cachedHit ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('table.cached')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
            {t('table.live')}
          </span>
        ),
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {/* ── Quota summary card (shared with AI Tools page) ─────────── */}
      <div className="mb-6">
        {storeId && <AiUsageSummaryCard storeId={storeId} embedded={false} />}
      </div>

      {/* ── Log table ──────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('table.title')}</h2>
        </div>

        {logLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : logError || !log || log.rows.length === 0 ? (
          <div className="px-6 py-8 text-center">
            {logError ? (
              <p className="text-sm text-destructive">{t('table.loadError')}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('table.empty')}</p>
            )}
          </div>
        ) : (
          <>
            <DataTable<UsageRow> columns={columns} rows={log.rows} rowKey={row => row.id} />

            {/* Pagination */}
            {log.pages > 1 && (
              <div className="flex items-center justify-between border-t px-6 py-3">
                <button
                  type="button"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="text-sm text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
                >
                  {t('table.prevPage')}
                </button>
                <span className="text-xs text-muted-foreground">
                  {t('table.pageInfo', { page: log.page, pages: log.pages })}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(p => Math.min(log.pages, p + 1))}
                  disabled={page >= log.pages}
                  className="text-sm text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
                >
                  {t('table.nextPage')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
