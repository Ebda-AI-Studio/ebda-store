'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice, filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface POItem {
  id: string;
  productId: string;
  productName: string;
  qty: number;
  qtyReceived: number;
  unitCost: number; // fils
}

interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  expectedDate: string | null;
  receivedDate: string | null;
  totalCost: number; // fils
  createdAt: string;
  notes: string | null;
  supplier: { id: string; name: string };
  items: POItem[];
}

interface POResponse {
  data: PurchaseOrder;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  partial: 'bg-amber-100 text-amber-700',
  received: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function PurchaseOrderDetailPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const poId = params?.poId as string;
  const router = useRouter();
  const t = useT('stock.purchaseOrders');
  const tDetail = useT('stock.purchaseOrders.detail');
  const tc = useT('common');

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Receive form: per-item qty inputs keyed by POItem.id
  const [receiptQtys, setReceiptQtys] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState(false);
  const [receiveError, setReceiveError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState(false);

  const loadPO = useCallback(() => {
    if (!storeId || !poId) return;
    setError(null);
    apiGet<POResponse>(`/api/v1/stores/${storeId}/purchase-orders/${poId}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data?.data) {
          const fetched = data.data;
          setPo(fetched);
          // Seed receive inputs with remaining qty (ordered - received)
          const defaults: Record<string, string> = {};
          for (const item of fetched.items) {
            const remaining = item.qty - item.qtyReceived;
            defaults[item.id] = remaining > 0 ? String(remaining) : '0';
          }
          setReceiptQtys(defaults);
        }
      })
      .catch(() => setError('Failed to load purchase order'));
  }, [storeId, poId]);

  useEffect(() => {
    loadPO();
  }, [loadPO]);

  async function handleReceive() {
    if (!po) return;
    setReceiveError(null);
    setReceiving(true);

    const receipts = po.items
      .map(item => ({
        poItemId: item.id,
        qtyReceived: parseInt(receiptQtys[item.id] ?? '0') || 0,
      }))
      .filter(r => r.qtyReceived > 0);

    if (receipts.length === 0) {
      setReceiveError('Enter at least one quantity to receive.');
      setReceiving(false);
      return;
    }

    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/purchase-orders/${poId}/receive`,
        { receipts }
      );
      if (apiError) {
        setReceiveError(apiError.message);
      } else {
        loadPO();
      }
    } catch (e: unknown) {
      setReceiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setReceiving(false);
    }
  }

  async function handleCancel() {
    if (!confirm(tDetail('cancelConfirm'))) return;
    setCancelling(true);
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/purchase-orders/${poId}/cancel`,
        {}
      );
      if (apiError) {
        setError(apiError.message);
      } else {
        loadPO();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!po) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  const canReceive = ['draft', 'sent', 'partial'].includes(po.status);
  const canCancel = po.status === 'draft';

  const itemColumns: DataTableColumn<POItem>[] = [
    {
      header: 'Product',
      primaryOnMobile: true,
      cell: item => <span className="truncate max-w-[12rem] block">{item.productName}</span>,
    },
    {
      header: 'Ordered',
      alignEnd: true,
      className: 'w-24',
      cell: item => <span className="font-mono text-xs">{item.qty}</span>,
    },
    {
      header: tDetail('qtyReceived'),
      alignEnd: true,
      className: 'w-24',
      cell: item => <span className="font-mono text-xs text-green-700">{item.qtyReceived}</span>,
    },
    {
      header: tDetail('qtyRemaining'),
      alignEnd: true,
      className: 'w-24',
      cell: item => {
        const remaining = item.qty - item.qtyReceived;
        return (
          <span
            className={`font-mono text-xs ${remaining > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}
          >
            {remaining}
          </span>
        );
      },
    },
    {
      header: 'Unit Cost (KWD)',
      alignEnd: true,
      className: 'w-28',
      cell: item => <span className="font-mono text-xs">{filsToKwd(item.unitCost)}</span>,
    },
    {
      header: 'Line Total (KWD)',
      alignEnd: true,
      hideOnMobile: true,
      className: 'w-28',
      cell: item => (
        <span className="font-mono text-xs">{((item.qty * item.unitCost) / 1000).toFixed(3)}</span>
      ),
    },
    ...(canReceive
      ? [
          {
            header: 'Receive Qty',
            alignEnd: true,
            className: 'w-28',
            cell: (item: POItem) => {
              const remaining = item.qty - item.qtyReceived;
              return (
                <input
                  type="number"
                  min="0"
                  max={remaining}
                  step="1"
                  value={receiptQtys[item.id] ?? ''}
                  onChange={e => setReceiptQtys(cur => ({ ...cur, [item.id]: e.target.value }))}
                  className="w-full border border-border rounded px-2 py-1 text-end font-mono text-base sm:text-sm"
                />
              );
            },
          } satisfies DataTableColumn<POItem>,
        ]
      : []),
  ];

  return (
    <AdminLayout title={po.poNumber} subtitle={po.supplier.name}>
      <div className="max-w-4xl space-y-6">
        {/* Header summary */}
        <div className="flex flex-wrap gap-4 items-start">
          <span
            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
              STATUS_CLASSES[po.status] ?? 'bg-muted text-muted-foreground'
            }`}
          >
            {t(`statuses.${po.status}`)}
          </span>

          <div className="text-sm text-muted-foreground space-x-4">
            {po.expectedDate && (
              <span>
                {t('expectedDate')}: {new Date(po.expectedDate).toLocaleDateString()}
              </span>
            )}
            {po.receivedDate && (
              <span>
                {t('receivedDate')}: {new Date(po.receivedDate).toLocaleDateString()}
              </span>
            )}
            <span>
              {t('total')}: <strong>{formatPrice(po.totalCost)}</strong>
            </span>
          </div>

          {canCancel && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="ms-auto px-3 py-1 border border-red-300 text-red-600 rounded text-sm hover:bg-red-50 disabled:opacity-40"
            >
              {cancelling ? 'Cancelling…' : tDetail('cancelButton')}
            </button>
          )}
        </div>

        {/* Items table */}
        <div>
          <DataTable<POItem> columns={itemColumns} rows={po.items} rowKey={item => item.id} />
          {/* DataTable has no footer concept, so the total is a summary bar
              right below the table — visible on both layouts. */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2 mt-3 text-sm font-medium">
            <span>{tDetail('totalLabel')}</span>
            <span className="font-mono font-semibold">{formatPrice(po.totalCost)}</span>
          </div>
        </div>

        {/* Receive section */}
        {canReceive && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{tDetail('receiveSection')}</h3>
            {receiveError && <div className="text-red-600 text-sm">{receiveError}</div>}
            <button
              type="button"
              onClick={handleReceive}
              disabled={receiving}
              className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
            >
              {receiving ? 'Receiving…' : tDetail('receiveButton')}
            </button>
            <p className="text-xs text-muted-foreground">{tDetail('receiveHelp')}</p>
          </div>
        )}

        {/* Back link */}
        <div>
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/purchase-orders`)}
            className="text-sm text-muted-foreground underline underline-offset-2 hover:opacity-80"
          >
            ← Back to purchase orders
          </button>
        </div>
      </div>
    </AdminLayout>
  );
}
