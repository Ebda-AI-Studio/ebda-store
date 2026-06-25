'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
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
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-start px-3 py-2 font-medium text-muted-foreground">Product</th>
                <th className="text-end px-3 py-2 w-24 font-medium text-muted-foreground">
                  Ordered
                </th>
                <th className="text-end px-3 py-2 w-24 font-medium text-muted-foreground">
                  {tDetail('qtyReceived')}
                </th>
                <th className="text-end px-3 py-2 w-24 font-medium text-muted-foreground">
                  {tDetail('qtyRemaining')}
                </th>
                <th className="text-end px-3 py-2 w-28 font-medium text-muted-foreground">
                  Unit Cost (KWD)
                </th>
                <th className="text-end px-3 py-2 w-28 font-medium text-muted-foreground">
                  Line Total (KWD)
                </th>
                {canReceive && (
                  <th className="text-end px-3 py-2 w-28 font-medium text-muted-foreground">
                    Receive Qty
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {po.items.map(item => {
                const remaining = item.qty - item.qtyReceived;
                const lineTotal = (item.qty * item.unitCost) / 1000;
                return (
                  <tr key={item.id} className="border-t border-border/40">
                    <td className="px-3 py-2 truncate max-w-[12rem]">{item.productName}</td>
                    <td className="px-3 py-2 text-end font-mono text-xs">{item.qty}</td>
                    <td className="px-3 py-2 text-end font-mono text-xs text-green-700">
                      {item.qtyReceived}
                    </td>
                    <td
                      className={`px-3 py-2 text-end font-mono text-xs ${
                        remaining > 0 ? 'text-amber-600' : 'text-muted-foreground'
                      }`}
                    >
                      {remaining}
                    </td>
                    <td className="px-3 py-2 text-end font-mono text-xs">
                      {filsToKwd(item.unitCost)}
                    </td>
                    <td className="px-3 py-2 text-end font-mono text-xs">{lineTotal.toFixed(3)}</td>
                    {canReceive && (
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          max={remaining}
                          step="1"
                          value={receiptQtys[item.id] ?? ''}
                          onChange={e =>
                            setReceiptQtys(cur => ({ ...cur, [item.id]: e.target.value }))
                          }
                          className="w-full border border-border rounded px-2 py-1 text-end font-mono text-base sm:text-sm"
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/20 border-t border-border">
              <tr>
                <td colSpan={canReceive ? 5 : 4} className="px-3 py-2 text-end text-sm font-medium">
                  Total
                </td>
                <td className="px-3 py-2 text-end font-mono text-sm font-semibold">
                  {formatPrice(po.totalCost)}
                </td>
                {canReceive && <td />}
              </tr>
            </tfoot>
          </table>
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
            <p className="text-xs text-muted-foreground">
              Receiving updates inventory levels and posts to the Inventory and Accounts Payable
              accounts.
            </p>
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
