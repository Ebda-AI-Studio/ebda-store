'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';

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

interface BackordersResponse {
  data: BackorderLine[];
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
  t: (key: string) => string;
}

function CancelModal({ backorderId, storeId, onClose, onSuccess, t }: CancelModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/backorders/${backorderId}/cancel`,
      { reason }
    );
    setSubmitting(false);
    if (apiError) {
      setError(apiError.message);
    } else {
      onSuccess();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl border border-border shadow-lg w-full max-w-md mx-4 p-6 space-y-4">
        <h2 className="text-base font-semibold">{t('cancelModal.title')}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-muted-foreground">
              {t('cancelModal.reasonLabel')}
            </label>
            <textarea
              className="w-full rounded border border-border bg-muted/20 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-red-600 text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-border text-sm text-muted-foreground hover:bg-muted/30"
            >
              {t('cancelModal.discard')}
            </button>
            <button
              type="submit"
              disabled={submitting || !reason.trim()}
              className="px-3 py-1.5 rounded bg-destructive text-destructive-foreground text-sm disabled:opacity-50"
            >
              {submitting ? '…' : t('cancelModal.confirm')}
            </button>
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
    apiGet<BackordersResponse>(`/api/v1/stores/${storeId}/backorders`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setLines(data?.data ?? []);
        }
      })
      .catch(() => setError('Failed to load backorders'));
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
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

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-4">
        {lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('orderNumber')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                    {t('customer')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                    {t('product')}
                  </th>
                  <th className="text-end px-3 py-2 font-medium text-muted-foreground w-16">
                    {t('qty')}
                  </th>
                  <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('daysWaiting')}
                  </th>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {lines.map(line => {
                  const order = line.orderItem.order;
                  const addr = order.shippingAddress;
                  const customerName = addr ? `${addr.firstName} ${addr.lastName}`.trim() : '—';
                  const days = daysWaiting(line.createdAt);

                  return (
                    <tr key={line.id} className="border-t border-border/40">
                      <td className="px-3 py-2">
                        <Link
                          href={`/stores/${storeId}/orders/${order.id}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          #{order.orderNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{customerName}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{line.product.name}</span>
                        {line.product.sku && (
                          <span className="ms-1 text-xs text-muted-foreground font-mono">
                            ({line.product.sku})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-xs">{line.qty}</td>
                      <td className="px-3 py-2 text-end text-muted-foreground text-xs">
                        {t('daysWaitingValue').replace('{days}', String(days))}
                      </td>
                      <td className="px-3 py-2 text-end">
                        <button
                          type="button"
                          onClick={() => setCancelTarget(line.id)}
                          className="px-2 py-1 rounded border border-destructive/40 text-destructive text-xs hover:bg-destructive/10"
                        >
                          {t('cancel')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
