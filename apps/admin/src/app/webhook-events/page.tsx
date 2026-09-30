'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { apiGet, apiPost } from '../../lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '../../i18n/useT';

/**
 * Super-admin: payment webhook inbox (WebhookEvent rows) + one-click replay.
 * Builder Reality Audit Lens E, E3-4 — the durable payment-webhook inbox now
 * has a UI (was Prisma-Studio-only). A wedged/failed row that P0-alerted can be
 * inspected and replayed here; the replay re-fires `payment/webhook.received`
 * and is idempotency-safe by construction.
 */
interface WebhookEvent {
  id: string;
  provider: string;
  storeId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  resultOrderId: string | null;
  resultStatus: string | null;
  idempotencyKey: string;
  receivedAt: string;
}

const STATUS_FILTERS = ['', 'received', 'processing', 'processed', 'failed'] as const;

function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'default' {
  if (status === 'processed') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'processing' || status === 'received') return 'warning';
  return 'default';
}

export default function WebhookEventsPage() {
  const t = useT('webhookEvents');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [replaying, setReplaying] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}&limit=100` : '?limit=100';
      const { data } = await apiGet<{ events: WebhookEvent[] }>(`/admin/webhook-events${qs}`);
      setEvents(data?.events || []);
    } catch (err) {
      console.error('Failed to fetch webhook events:', err);
      setMessage(t('failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const replay = async (id: string, force = false) => {
    setReplaying(id);
    setMessage(null);
    // apiPost resolves { data, error } (never throws), so branch on error.
    const res = await apiPost(`/admin/webhook-events/${id}/replay`, force ? { force: true } : {});
    if (res.error) {
      // Money-path guard: an already-processed webhook needs explicit confirm
      // before re-firing the payment event (idempotency-safe, but deliberate).
      if (!force && res.error.code === 'WEBHOOK_ALREADY_PROCESSED') {
        setReplaying(null);
        if (window.confirm(t('confirmAlreadyProcessed'))) {
          return replay(id, true);
        }
        setMessage(t('replayCancelled'));
        return;
      }
      setMessage(t('replayFailed', { message: res.error.message || 'error' }));
      setReplaying(null);
      return;
    }
    setMessage(t('replaySuccess', { id: id.slice(0, 8) }));
    await fetchEvents();
    setReplaying(null);
  };

  const columns: DataTableColumn<WebhookEvent>[] = [
    {
      header: t('columns.received'),
      cell: ev => <span className="text-gray-600">{new Date(ev.receivedAt).toLocaleString()}</span>,
    },
    {
      header: t('columns.provider'),
      primaryOnMobile: true,
      cell: ev => <span className="font-medium text-gray-900">{ev.provider}</span>,
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: ev => <Badge variant={statusVariant(ev.status)}>{ev.status}</Badge>,
    },
    {
      header: t('columns.attempts'),
      hideOnMobile: true,
      cell: ev => <span className="text-gray-600">{ev.attempts}</span>,
    },
    {
      header: t('columns.result'),
      hideOnMobile: true,
      cell: ev =>
        ev.resultOrderId ? (
          <span className="text-gray-600" title={ev.resultOrderId}>
            {ev.resultStatus || t('columns.resultOk')} · {ev.resultOrderId.slice(0, 8)}
          </span>
        ) : (
          <span className="text-gray-600">—</span>
        ),
    },
    {
      header: t('columns.lastError'),
      cell: ev => (
        <span className="block max-w-[240px] truncate text-destructive" title={ev.lastError || ''}>
          {ev.lastError || '—'}
        </span>
      ),
    },
    {
      header: t('columns.action'),
      mobileActions: true,
      cell: ev => (
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11 max-md:px-4"
          disabled={replaying === ev.id}
          onClick={() => replay(ev.id)}
        >
          {replaying === ev.id ? t('replaying') : t('replay')}
        </Button>
      ),
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-end gap-3">
          <Link href="/email-queue" className="text-sm text-primary hover:underline">
            {t('emailQueueLink')}
          </Link>
          <Button variant="outline" size="sm" onClick={() => fetchEvents()}>
            {t('refresh')}
          </Button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {STATUS_FILTERS.map(s => (
            <button
              key={s || 'all'}
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-sm ${
                status === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'
              }`}
            >
              {s || t('statusAll')}
            </button>
          ))}
        </div>

        {message && (
          <div className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary">
            {message}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-gray-200 px-3 py-6 text-center text-gray-400">
            {t('loading')}
          </div>
        ) : (
          <DataTable<WebhookEvent>
            columns={columns}
            rows={events}
            rowKey={ev => ev.id}
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
