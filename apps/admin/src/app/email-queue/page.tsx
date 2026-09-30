'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { apiGet, apiPost } from '../../lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '../../i18n/useT';

/**
 * Super-admin: the email queue's dead-letter list (`email:failed` in Redis)
 * + one-click replay. Issue 2142 — an order / refund / return email queued
 * with `{ queue: true }` that fails every attempt used to vanish into that
 * list with only a log line; it now P1-alerts (`email.queue.permanent_failure`)
 * and is listed here. Recipient addresses are masked by the API.
 */
interface FailedEmail {
  id: string;
  storeId: string | null;
  to: Array<string | null>;
  subject: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  lastAttempt: string | null;
}

export default function EmailQueuePage() {
  const t = useT('emailQueue');
  const [emails, setEmails] = useState<FailedEmail[]>([]);
  const [stats, setStats] = useState<{ pending: number; failed: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchFailed = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiGet<{
        emails: FailedEmail[];
        stats: { pending: number; failed: number };
      }>('/admin/email-queue/failed?limit=100');
      setEmails(data?.emails || []);
      setStats(data?.stats ?? null);
    } catch (err) {
      console.error('Failed to fetch failed emails:', err);
      setMessage(t('failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchFailed();
  }, [fetchFailed]);

  const retryAll = async () => {
    if (!window.confirm(t('confirmRetry'))) return;
    setRetrying(true);
    setMessage(null);
    // apiPost resolves { data, error } (never throws), so branch on error.
    const res = await apiPost<{ retried: number }>('/admin/email-queue/failed/retry', {});
    if (res.error) {
      setMessage(t('retryFailed', { message: res.error.message || 'error' }));
    } else {
      setMessage(t('retrySuccess', { count: res.data?.retried ?? 0 }));
      await fetchFailed();
    }
    setRetrying(false);
  };

  const columns: DataTableColumn<FailedEmail>[] = [
    {
      header: t('columns.created'),
      cell: e => <span className="text-gray-600">{new Date(e.createdAt).toLocaleString()}</span>,
    },
    {
      header: t('columns.subject'),
      primaryOnMobile: true,
      cell: e => (
        <span className="block max-w-[260px] truncate font-medium text-gray-900" title={e.subject}>
          {e.subject}
        </span>
      ),
    },
    {
      header: t('columns.to'),
      hideOnMobile: true,
      cell: e => <span className="text-gray-600">{e.to.filter(Boolean).join(', ') || '—'}</span>,
    },
    {
      header: t('columns.attempts'),
      mobileBadge: true,
      cell: e => <Badge variant="destructive">{e.attempts}</Badge>,
    },
    {
      header: t('columns.error'),
      cell: e => (
        <span className="block max-w-[240px] truncate text-destructive" title={e.error || ''}>
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
            <Button variant="outline" size="sm" onClick={() => fetchFailed()}>
              {t('refresh')}
            </Button>
            <Button size="sm" disabled={retrying || emails.length === 0} onClick={retryAll}>
              {retrying ? t('retrying') : t('retryAll')}
            </Button>
          </div>
        </div>

        {message && (
          <div className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary-ink">
            {message}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-gray-200 px-3 py-6 text-center text-gray-400">
            {t('loading')}
          </div>
        ) : (
          <DataTable<FailedEmail>
            ariaLabel={t('title')}
            columns={columns}
            rows={emails}
            rowKey={e => e.id}
            emptyState={
              <div className="rounded-lg border border-gray-200 px-3 py-6 text-center text-gray-400">
                {t('empty')}
              </div>
            }
          />
        )}
      </div>
    </AdminLayout>
  );
}
