'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice } from '@/lib/format';

import { Button } from '@/components/ui/Button';
import { TEXTAREA_CLASSES } from '@/components/ui/tokens';
// ─── Types ────────────────────────────────────────────────────────────────────

interface BackorderLine {
  id: string;
  qty: number;
  createdAt: string;
  product: {
    id: string;
    name: string;
    sku: string | null;
  };
  orderItem: {
    order: {
      id: string;
      orderNumber: string;
      shippingAddress: {
        firstName: string;
        lastName: string;
      } | null;
    };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysWaiting(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ─── Cancel Modal ─────────────────────────────────────────────────────────────

interface CancelModalProps {
  backorderId: string;
  storeId: string;
  onClose: () => void;
  onSuccess: () => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}

/**
 * Cancelling a backorder line reverses the sale in the books but sends NO
 * money (Ruling AP-5b(2)) — so the modal says that before, and states the sum
 * the merchant still owes after (issue 2275), instead of "Cancel & Refund".
 */
function CancelModal({ backorderId, storeId, onClose, onSuccess, t }: CancelModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owed, setOwed] = useState<number | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { data, error: apiError } = await apiPost<{ owedToCustomer?: number }>(
      `/api/v1/stores/${storeId}/backorders/${backorderId}/cancel`,
      { reason }
    );
    setSubmitting(false);
    if (apiError) {
      setError(apiError.message);
      return;
    }
    onSuccess();
    const owedToCustomer = data?.owedToCustomer ?? 0;
    if (owedToCustomer > 0) setOwed(owedToCustomer);
    else onClose();
  }

  if (owed !== null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-background rounded-md border border-border shadow-md w-full max-w-md mx-4 p-6 space-y-4">
          <h2 className="text-base font-semibold">{t('cancelModal.doneTitle')}</h2>
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-ink">
            {t('cancelModal.owedNotice', { amount: formatPrice(owed) })}
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose} variant="default" size="sm">
              {t('cancelModal.ok')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-md border border-border shadow-md w-full max-w-md mx-4 p-6 space-y-4">
        <h2 className="text-base font-semibold">{t('cancelModal.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('cancelModal.body')}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-muted-foreground">
              {t('cancelModal.reasonLabel')}
            </label>
            <textarea
              className={`${TEXTAREA_CLASSES} resize-none`}
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-destructive-ink text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={onClose}
              variant="outline"
              size="sm"
              className="text-muted-foreground"
            >
              {t('cancelModal.discard')}
            </Button>
            <Button
              type="submit"
              disabled={submitting || !reason.trim()}
              variant="destructive"
              size="sm"
              className="text-destructive-foreground"
            >
              {submitting ? '…' : t('cancelModal.confirm')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BackordersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('stock.backorders');
  const tc = useT('common');

  const [lines, setLines] = useState<BackorderLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!storeId) return;
    setError(null);
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the backorder line array — reading `data?.data` double-
    // unwrapped to undefined and the page always rendered empty (#831).
    apiGet<BackorderLine[]>(`/api/v1/stores/${storeId}/backorders`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setLines(data ?? []);
        }
      })
      .catch(() => setError(t('loadFailed')));
  }, [storeId, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-destructive-ink text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!lines) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  const columns: DataTableColumn<BackorderLine>[] = [
    {
      header: t('product'),
      primaryOnMobile: true,
      cell: line => (
        <>
          <span className="font-medium">{line.product.name}</span>
          {line.product.sku && (
            <span className="ms-1 text-xs text-muted-foreground font-mono">
              ({line.product.sku})
            </span>
          )}
        </>
      ),
    },
    {
      header: t('orderNumber'),
      className: 'w-28',
      cell: line => (
        <Link
          href={`/stores/${storeId}/orders/${line.orderItem.order.id}`}
          className="font-mono text-xs text-primary hover:underline"
        >
          #{line.orderItem.order.orderNumber}
        </Link>
      ),
    },
    {
      header: t('customer'),
      cell: line => {
        const addr = line.orderItem.order.shippingAddress;
        const customerName = addr ? `${addr.firstName} ${addr.lastName}`.trim() : '—';
        return <span className="text-muted-foreground">{customerName}</span>;
      },
    },
    {
      header: t('qty'),
      alignEnd: true,
      className: 'w-16',
      cell: line => <span className="font-mono text-xs">{line.qty}</span>,
    },
    {
      header: t('daysWaiting'),
      alignEnd: true,
      className: 'w-28',
      cell: line => (
        <span className="text-muted-foreground text-xs">
          {t('daysWaitingValue', { days: String(daysWaiting(line.createdAt)) })}
        </span>
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      className: 'w-20',
      cell: line => (
        <Button
          type="button"
          onClick={() => setCancelTarget(line.id)}
          variant="outline"
          size="sm"
          className="text-destructive-ink"
        >
          {t('cancel')}
        </Button>
      ),
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-4">
        <DataTable<BackorderLine>
          ariaLabel={t('title')}
          columns={columns}
          rows={lines}
          rowKey={line => line.id}
          emptyState={<p className="text-muted-foreground text-sm">{t('empty')}</p>}
        />
      </div>

      {cancelTarget && (
        <CancelModal
          backorderId={cancelTarget}
          storeId={storeId}
          onClose={() => setCancelTarget(null)}
          onSuccess={load}
          t={t}
        />
      )}
    </AdminLayout>
  );
}
