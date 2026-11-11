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
import { PageState } from '../../../../components/PageState';
import { useAuth } from '../../../../lib/auth';
import { apiGet } from '../../../../lib/api';
import { AiUsageSummaryCard } from '../../../../components/ai/AiUsageSummaryCard';
import { AiSwitchCard } from '../../../../components/ai/AiSwitchCard';
import { DataTable, type DataTableColumn } from '../../../../components/mobile/DataTable';
import { useT } from '../../../../i18n/useT';
import { formatSpend } from '../../../../lib/ai-spend';
import { withNumerals } from '@ebda/shared';
import { intlLocaleForUi } from '@/lib/format';
import { Button } from '@/components/ui/Button';

// ── Types ─────────────────────────────────────────────────────────────

interface UsageRow {
  id: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cachedHit: boolean;
  createdAt: string;
  /** Issues 2204/2226: provenance + cost the API already returns. */
  model: string | null;
  /** Micros of the billing currency; null = the model has no configured rate. */
  costMicros: number | null;
  subjectType: string | null;
  subjectId: string | null;
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
  return new Date(iso).toLocaleString(intlLocaleForUi('en-GB'), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Product · 1a2b3c4d" — what the call was about; "—" when not recorded. */
function subjectLabel(row: UsageRow): string {
  if (!row.subjectType) return '—';
  const kind = formatFeature(row.subjectType);
  return row.subjectId ? `${kind} · ${row.subjectId.slice(0, 8)}` : kind;
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
      setLogLoading(true);
      try {
        // apiGet already unwraps the API's `{ success, data }` envelope, so
        // `data` IS the LogData object — reading `data?.data` double-
        // unwrapped to undefined and the log table always rendered empty
        // (#831 sweep).
        const logRes = await apiGet<LogData>(
          `/api/v1/stores/${storeId}/ai/usage/log?page=${p}&pageSize=20`
        );
        if (logRes.error) {
          setLogError(true);
          return;
        }
        setLog(logRes.data ?? null);
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
            ? (row.inputTokens + row.outputTokens).toLocaleString(undefined, withNumerals())
            : '—'}
        </span>
      ),
    },
    {
      header: t('table.model'),
      hideOnMobile: true,
      cell: row => <span className="text-muted-foreground text-xs">{row.model ?? '—'}</span>,
    },
    {
      header: t('table.cost'),
      alignEnd: true,
      cell: row =>
        row.costMicros == null ? (
          <span className="text-xs text-warning-ink" title={t('table.unpricedHint')}>
            {t('table.unpriced')}
          </span>
        ) : (
          <span className="tabular-nums text-foreground">{formatSpend(row.costMicros)}</span>
        ),
    },
    {
      header: t('table.subject'),
      hideOnMobile: true,
      cell: row => (
        <span className="text-muted-foreground text-xs" title={row.subjectId ?? undefined}>
          {subjectLabel(row)}
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
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary-ink">
            {t('table.live')}
          </span>
        ),
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="mb-4" data-setting-id="ai.switch">
        {storeId && <AiSwitchCard storeId={storeId} />}
      </div>

      {/* ── Quota summary card (shared with AI Tools page) ─────────── */}
      <div className="mb-6">
        {storeId && <AiUsageSummaryCard storeId={storeId} embedded={false} />}
      </div>

      {/* ── Log table ──────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('table.title')}</h2>
        </div>

        <PageState
          loading={logLoading}
          error={logError ? t('table.loadError') : null}
          onRetry={() => void fetchLog(page)}
          empty={!log || log.rows.length === 0 ? { title: t('table.empty') } : null}
        >
          {log && (
            <>
              <DataTable<UsageRow>
                ariaLabel={t('table.title')}
                columns={columns}
                rows={log.rows}
                rowKey={row => row.id}
              />

              {/* Pagination */}
              {log.pages > 1 && (
                <div className="flex items-center justify-between border-t px-6 py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    {t('table.prevPage')}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t('table.pageInfo', { page: log.page, pages: log.pages })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setPage(p => Math.min(log.pages, p + 1))}
                    disabled={page >= log.pages}
                  >
                    {t('table.nextPage')}
                  </Button>
                </div>
              )}
            </>
          )}
        </PageState>
      </div>
    </AdminLayout>
  );
}
