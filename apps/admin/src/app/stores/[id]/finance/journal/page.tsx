'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { DateRangePicker } from '../../../../../components/DateRangePicker';
import { useT } from '@/i18n/useT';
import { apiGetPage, type PageMeta } from '@/lib/api';
import { PageControls } from '../../../../../components/PageControls';
import { minorToMajor } from '@/lib/format';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { useNotifications, useUiRefresh } from '@/contexts/NotificationContext';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';
import { withNumerals } from '@ebda/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JournalLine {
  id: string;
  debit: number;
  credit: number;
  lineMemo: string | null;
  account: { code: string; nameEn: string; nameAr: string | null };
}

interface JournalEntry {
  id: string;
  entryNumber: string;
  postedAt: string;
  source: string;
  memo: string | null;
  status: 'posted' | 'reversed' | 'draft';
  lines: JournalLine[];
}

const PER_PAGE = 100;

// ─── Component ────────────────────────────────────────────────────────────────

export default function JournalListPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.journal');
  const tNew = useT('finance.newEntry');
  const tc = useT('common');
  const router = useRouter();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const { subscribeToStore, unsubscribeFromStore } = useNotifications();

  const [period, setPeriod] = useState<Period>('this_month');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);

  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  // `meta` from the route: without it a list capped at PER_PAGE rows silently drops the rest of the
  // audit trail (issue 2430).
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  // Increment to trigger a refetch without resetting entries to null (avoids flicker)
  const [refreshKey, setRefreshKey] = useState(0);

  // Subscribe to this store's socket room so ui-refresh signals reach us
  useEffect(() => {
    if (!storeId) return;
    subscribeToStore(storeId);
    return () => unsubscribeFromStore(storeId);
  }, [storeId, subscribeToStore, unsubscribeFromStore]);

  // When the server posts a new journal entry, refetch the list
  useUiRefresh(
    'ui/journal-posted',
    useCallback(() => setRefreshKey(k => k + 1), [])
  );

  // When a journal entry is reversed, refetch the list
  useUiRefresh(
    'ui/journal-reversed',
    useCallback(() => setRefreshKey(k => k + 1), [])
  );

  // Latest-request-wins: a slower response for the previous window/page must not repaint its rows
  // under the new one (issue 2436).
  const beginRequest = useLatestRequest();

  useEffect(() => {
    if (!storeId) return;
    const isLatest = beginRequest();

    const resolved = resolveDateRange(period, customRange);
    // The journal API expects full ISO datetime strings for from/to
    const from = resolved.startDate.toISOString();
    const to = resolved.endDate.toISOString();

    apiGetPage<JournalEntry>(
      `/api/v1/stores/${storeId}/finance/journal?perPage=${PER_PAGE}&page=${page}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    )
      .then(({ data, meta: pageMeta, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          setError(apiError.message);
        } else {
          setError(null);
          setEntries(data ?? []);
          setMeta(pageMeta);
        }
      })
      .catch(() => {
        if (isLatest()) setError('Failed to load journal entries');
      });
  }, [storeId, refreshKey, period, customRange, page, beginRequest]);

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <DateRangePicker
        period={period}
        custom={customRange}
        onChange={(p, c) => {
          setPeriod(p);
          if (c) setCustomRange(c);
          // A new date window is a new list: start it on page 1, batched with the window change
          // so exactly one request goes out (issue 2436).
          setPage(1);
        }}
      />

      {error && (
        <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
        </div>
      )}

      {!entries && !error && (
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      )}

      {entries && (
        <div className="max-w-5xl space-y-4">
          {/* New Entry button: only super_admin can post manual journal entries. */}
          {isSuperAdmin && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => router.push(`/stores/${storeId}/finance/journal/new`)}
                className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
              >
                {tNew('addNew')}
              </button>
            </div>
          )}
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noEntries')}</p>
          ) : (
            <>
              {meta && (
                <p className="text-sm text-muted-foreground" data-testid="journal-total">
                  {t('totalCount', { total: meta.total.toLocaleString(undefined, withNumerals()) })}
                </p>
              )}
              {/* Journal entries list — genuine accounting ledger (columns are
               the point); kept as an isolated horizontal-scroll container
               per the B1 mobile-table exception rather than card-stacked. */}
              <div className="rounded-xl border border-border overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                        {t('entryNumber')}
                      </th>
                      <th className="text-start px-3 py-2 font-medium text-muted-foreground w-40">
                        {t('postedAt')}
                      </th>
                      <th className="text-start px-3 py-2 font-medium text-muted-foreground w-32">
                        {t('source')}
                      </th>
                      <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                        {t('memo')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                        {t('debit')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                        {t('credit')}
                      </th>
                      <th className="px-3 py-2 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(entry => {
                      const dr = entry.lines.reduce((s, l) => s + l.debit, 0);
                      const cr = entry.lines.reduce((s, l) => s + l.credit, 0);
                      const isReversed = entry.status === 'reversed';
                      return (
                        <tr
                          key={entry.id}
                          className={`border-t border-border/40 ${isReversed ? 'opacity-60' : ''}`}
                        >
                          <td
                            className={`px-3 py-2 font-mono text-xs ${isReversed ? 'line-through' : ''}`}
                          >
                            {entry.entryNumber}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {new Date(entry.postedAt).toLocaleDateString(undefined, withNumerals())}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground capitalize">
                            {entry.source.replace(/_/g, ' ')}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-[12rem]">
                            {entry.memo ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-end font-mono text-xs">
                            {minorToMajor(dr)}
                          </td>
                          <td className="px-3 py-2 text-end font-mono text-xs">
                            {minorToMajor(cr)}
                          </td>
                          <td className="px-3 py-2 text-end">
                            <Link
                              href={`/stores/${storeId}/finance/journal/${entry.id}`}
                              className="text-primary text-xs underline underline-offset-2"
                            >
                              {t('viewDetail')}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <PageControls meta={meta} onPageChange={setPage} />
            </>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
