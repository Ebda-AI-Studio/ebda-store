'use client';

import { intlLocaleForUi } from '@/lib/format';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../components/AdminLayout';
import { apiGet, apiPost } from '../../lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '../../i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { withNumerals } from '@ebda/shared';

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
  const askConfirm = useConfirm();
  const [emails, setEmails] = useState<FailedEmail[]>([]);
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
  // "No failed emails" with "Retry all" disabled.
  const [loadError, setLoadError] = useState(false);

  const fetchFailed = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await apiGet<{
        emails: FailedEmail[];
        stats: { pending: number; failed: number; corrupt?: number };
        corrupt?: Array<{ position: number; bytes: number }>;
      }>('/api/v1/admin/email-queue/failed?limit=100');
      setLoadError(!!error);
      setEmails(data?.emails || []);
      setStats(data?.stats ?? null);
      setCorrupt(data?.corrupt ?? []);
    } catch (err) {
      console.error('Failed to fetch failed emails:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFailed();
  }, [fetchFailed]);

  const retryAll = async () => {
    const ok = await askConfirm({
      object: t('confirmRetryObject'),
      consequence: t('confirmRetry'),
      confirmLabel: t('retryAll'),
      tone: 'default',
    });
    if (!ok) return;
    setRetrying(true);
    setMessage(null);
    // apiPost resolves { data, error } (never throws), so branch on error.
    const res = await apiPost<{ retried: number; skipped?: number; kept?: number }>(
      '/api/v1/admin/email-queue/failed/retry',
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

  // Issue 2353: unreadable entries set aside by "Retry all" — they cannot be
  // replayed, so the only actions are to see how many there are and discard.
  const discardCorrupt = async () => {
    const ok = await askConfirm({
      object: t('corrupt.discardObject'),
      consequence: t('corrupt.confirmDiscard'),
      confirmLabel: t('corrupt.discard'),
    });
    if (!ok) return;
    setDiscarding(true);
    setMessage(null);
    const res = await apiPost<{ discarded: number }>(
      '/api/v1/admin/email-queue/corrupt/discard',
      {}
    );
    if (res.error) {
      setMessage(t('retryFailed', { message: res.error.message || 'error' }));
    } else {
      setMessage(t('corrupt.discarded', { count: res.data?.discarded ?? 0 }));
      await fetchFailed();
    }
    setDiscarding(false);
  };

  const columns: DataTableColumn<FailedEmail>[] = [
    {
      header: t('columns.created'),
      cell: e => (
        <span className="text-muted-foreground">
          {new Date(e.createdAt).toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
    {
      header: t('columns.subject'),
      primaryOnMobile: true,
      cell: e => (
        <span
          className="block max-w-[260px] truncate font-medium text-foreground"
          title={e.subject}
        >
          {e.subject}
        </span>
      ),
    },
    {
      header: t('columns.to'),
      hideOnMobile: true,
      cell: e => (
        <span className="text-muted-foreground">{e.to.filter(Boolean).join(', ') || '—'}</span>
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
            <Link href="/sms-queue" className="text-sm text-primary hover:underline">
              {t('smsQueueLink')}
            </Link>
            <Button variant="outline" size="sm" onClick={() => fetchFailed()}>
              {t('refresh')}
            </Button>
            <Button
              size="sm"
              disabled={retrying || (stats ? stats.failed === 0 : emails.length === 0)}
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
          <DataTable<FailedEmail>
            ariaLabel={t('title')}
            columns={columns}
            rows={emails}
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
