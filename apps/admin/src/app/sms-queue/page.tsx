'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@ebda/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { apiGet, apiPost } from '../../lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '../../i18n/useT';
import { withNumerals } from '@ebda/shared';

/**
 * Super-admin: the SMS queue's dead-letter list (`sms:failed` in Redis) +
 * one-click replay + the unreadable set-aside list (issue 2363). The twin of
 * `/email-queue`: before this page, `sms:failed` held real customer messages
 * with no viewer, no replay and no discard. The recipient number is masked by
 * the API; the message text is never returned.
 */
interface FailedSms {
  id: string;
  storeId: string | null;
  event: string | null;
  to: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  lastAttempt: string | null;
}

export default function SmsQueuePage() {
  const t = useT('smsQueue');
  const [messages, setMessages] = useState<FailedSms[]>([]);
  const [stats, setStats] = useState<{ pending: number; failed: number; corrupt?: number } | null>(
    null
  );
  const [corrupt, setCorrupt] = useState<Array<{ position: number; bytes: number }>>([]);
  const [discarding, setDiscarding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Issue 2375: apiGet never throws — a 403/500/unreachable API resolves as
  // `{ data: null, error }`. Read the error channel, or an outage renders as
  // "No failed SMS" with "Retry all" disabled.
  const [loadError, setLoadError] = useState(false);

  const fetchFailed = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await apiGet<{
        messages: FailedSms[];
        stats: { pending: number; failed: number; corrupt?: number };
        corrupt?: Array<{ position: number; bytes: number }>;
      }>('/api/v1/admin/sms-queue/failed?limit=100');
      setLoadError(!!error);
      setMessages(data?.messages || []);
      setStats(data?.stats ?? null);
      setCorrupt(data?.corrupt ?? []);
    } catch (err) {
      console.error('Failed to fetch failed SMS:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFailed();
  }, [fetchFailed]);

  const retryAll = async () => {
    if (!window.confirm(t('confirmRetry'))) return;
    setRetrying(true);
    setMessage(null);
    // apiPost resolves { data, error } (never throws), so branch on error.
    const res = await apiPost<{ retried: number; skipped?: number; kept?: number }>(
      '/api/v1/admin/sms-queue/failed/retry',
      {}
    );
    if (res.error) {
      setMessage(t('retryFailed', { message: res.error.message || 'error' }));
    } else {
      const skipped = res.data?.skipped ?? 0;
      const kept = res.data?.kept ?? 0;
      const base =
        skipped > 0
          ? t('retryPartial', { count: res.data?.retried ?? 0, skipped })
          : t('retrySuccess', { count: res.data?.retried ?? 0 });
      // Issue 2361: entries a Redis write rejected mid-replay stay on the list.
      setMessage(kept > 0 ? `${base} · ${t('retryKept', { kept })}` : base);
      await fetchFailed();
    }
    setRetrying(false);
  };

  // Unreadable entries set aside by "Retry all" — they cannot be replayed,
  // so the only actions are to see how many there are and discard.
  const discardCorrupt = async () => {
    if (!window.confirm(t('corrupt.confirmDiscard'))) return;
    setDiscarding(true);
    setMessage(null);
    const res = await apiPost<{ discarded: number }>('/api/v1/admin/sms-queue/corrupt/discard', {});
    if (res.error) {
      setMessage(t('retryFailed', { message: res.error.message || 'error' }));
    } else {
      setMessage(t('corrupt.discarded', { count: res.data?.discarded ?? 0 }));
      await fetchFailed();
    }
    setDiscarding(false);
  };

  const columns: DataTableColumn<FailedSms>[] = [
    {
      header: t('columns.created'),
      cell: e => (
        <span className="text-muted-foreground">
          {new Date(e.createdAt).toLocaleString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('columns.event'),
      primaryOnMobile: true,
      cell: e => <span className="font-medium text-foreground">{e.event || '—'}</span>,
    },
    {
      header: t('columns.to'),
      hideOnMobile: true,
      cell: e => (
        <span className="text-muted-foreground" dir="ltr">
          {e.to || '—'}
        </span>
      ),
    },
    {
      header: t('columns.attempts'),
      mobileBadge: true,
      cell: e => <Badge variant="destructive">{e.attempts}</Badge>,
    },
    {
      header: t('columns.error'),
      cell: e => (
        <span className="block max-w-[240px] truncate text-destructive-ink" title={e.error || ''}>
          {e.error || '—'}
        </span>
      ),
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {stats
              ? t('stats', { pending: stats.pending, failed: stats.failed })
              : t('statsUnknown')}
          </p>
          <div className="flex gap-2">
            <Link href="/webhook-events" className="text-sm text-primary hover:underline">
              {t('webhookInboxLink')}
            </Link>
            <Link href="/email-queue" className="text-sm text-primary hover:underline">
              {t('emailQueueLink')}
            </Link>
            <Button variant="outline" size="sm" onClick={() => fetchFailed()}>
              {t('refresh')}
            </Button>
            <Button
              size="sm"
              disabled={retrying || (stats ? stats.failed === 0 : messages.length === 0)}
              onClick={retryAll}
            >
              {retrying ? t('retrying') : t('retryAll')}
            </Button>
          </div>
        </div>

        {message && (
          <div className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary-ink">
            {message}
          </div>
        )}

        {(stats?.corrupt ?? 0) > 0 && (
          <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-ink">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{t('corrupt.title', { count: stats?.corrupt ?? 0 })}</p>
              <Button variant="outline" size="sm" disabled={discarding} onClick={discardCorrupt}>
                {discarding ? t('corrupt.discarding') : t('corrupt.discard')}
              </Button>
            </div>
            <p className="mt-1 text-xs">{t('corrupt.body')}</p>
            {corrupt.length > 0 && (
              <p className="mt-1 text-xs">
                {t('corrupt.sizes', { sizes: corrupt.map(c => c.bytes).join(', ') })}
              </p>
            )}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
            {t('loading')}
          </div>
        ) : (
          <DataTable<FailedSms>
            ariaLabel={t('title')}
            columns={columns}
            rows={messages}
            rowKey={e => e.id}
            emptyState={
              loadError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
                >
                  {t('failedToLoad')}
                </div>
              ) : (
                <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
                  {(stats?.failed ?? 0) > 0 ? t('emptyUnreadable') : t('empty')}
                </div>
              )
            }
          />
        )}
      </div>
    </AdminLayout>
  );
}
