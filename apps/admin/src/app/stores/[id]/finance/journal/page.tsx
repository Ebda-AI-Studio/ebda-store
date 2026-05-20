'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { useNotifications, useUiRefresh } from '@/contexts/NotificationContext';

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

// ─── Component ────────────────────────────────────────────────────────────────

export default function JournalListPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.journal');
  const tNew = useT('finance.newEntry');
  const tc = useT('common');
  const router = useRouter();

  const { subscribeToStore, unsubscribeFromStore } = useNotifications();

  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
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

  useEffect(() => {
    if (!storeId) return;
    apiGet<JournalEntry[]>(`/api/v1/stores/${storeId}/finance/journal?perPage=100`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setEntries(data ?? []);
        }
      })
      .catch(() => setError('Failed to load journal entries'));
  }, [storeId, refreshKey]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!entries) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-4">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/finance/journal/new`)}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
          >
            {tNew('addNew')}
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noEntries')}</p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
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
                        {new Date(entry.postedAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground capitalize">
                        {entry.source.replace(/_/g, ' ')}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[12rem]">
                        {entry.memo ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-xs">
                        {(dr / 1000).toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-xs">
                        {(cr / 1000).toFixed(3)}
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
        )}
      </div>
    </AdminLayout>
  );
}
