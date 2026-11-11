'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { DateRangePicker } from '../../../../../components/DateRangePicker';
import { useT } from '@/i18n/useT';
import { apiGetPage, type PageMeta } from '@/lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { Button } from '@/components/ui/Button';
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
        if (isLatest()) setError(t('loadFailed'));
      });
  }, [storeId, refreshKey, period, customRange, page, beginRequest]);

  const columns: DataTableColumn<JournalEntry>[] = [
    {
      header: t('entryNumber'),
      primaryOnMobile: true,
      cell: entry => (
        <span
          className={`font-mono text-xs ${entry.status === 'reversed' ? 'line-through opacity-60' : ''}`}
        >
          {entry.entryNumber}
        </span>
      ),
    },
    {
      header: t('postedAt'),
      cell: entry => (
        <span className="text-muted-foreground">
          {new Date(entry.postedAt).toLocaleDateString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('source'),
      hideOnMobile: true,
      cell: entry => (
        <span className="text-muted-foreground capitalize">{entry.source.replace(/_/g, ' ')}</span>
      ),
    },
    {
      header: t('memo'),
      hideOnMobile: true,
      cell: entry => (
        <span
          className="block max-w-[12rem] truncate text-muted-foreground"
          title={entry.memo ?? undefined}
        >
          {entry.memo ?? '—'}
        </span>
      ),
    },
    {
      header: t('debit'),
      alignEnd: true,
      cell: entry => (
        <span className="font-mono text-xs">
          {minorToMajor(entry.lines.reduce((s, l) => s + l.debit, 0))}
        </span>
      ),
    },
    {
      header: t('credit'),
      alignEnd: true,
      hideOnMobile: true,
      cell: entry => (
        <span className="font-mono text-xs">
          {minorToMajor(entry.lines.reduce((s, l) => s + l.credit, 0))}
        </span>
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      cell: entry => (
        <Link
          href={`/stores/${storeId}/finance/journal/${entry.id}`}
          className="inline-flex min-h-11 items-center text-xs font-medium text-primary-ink underline underline-offset-2"
        >
          {t('viewDetail')}
        </Link>
      ),
    },
  ];

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        // Only super_admin can post manual journal entries.
        isSuperAdmin ? (
          <Button onClick={() => router.push(`/stores/${storeId}/finance/journal/new`)}>
            {tNew('addNew')}
          </Button>
        ) : undefined
      }
    >
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
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
        </div>
      )}

      {!entries && !error && (
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      )}

      {entries && (
        <div className="max-w-5xl space-y-4">
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noEntries')}</p>
          ) : (
            <>
              {meta && (
                <p className="text-sm text-muted-foreground" data-testid="journal-total">
                  {t('totalCount', { total: meta.total.toLocaleString(undefined, withNumerals()) })}
                </p>
              )}
              <DataTable<JournalEntry>
                ariaLabel={t('title')}
                columns={columns}
                rows={entries}
                rowKey={entry => entry.id}
              />
              <PageControls meta={meta} onPageChange={setPage} />
            </>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
