'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice, minorToMajor, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { RowActions } from '@/components/RowActions';
import { PageState } from '@/components/PageState';
import { useConfirm } from '@/hooks/useConfirm';

import { minorToDecimalString } from '@ebda/shared';
import { FIELD_CLASSES } from '@/components/ui/tokens';
// ─── Types ────────────────────────────────────────────────────────────────────

interface POItem {
  id: string;
  productId: string;
  // getPurchaseOrder includes these relations; there is no flat
  // `productName` on the row (reading one rendered an empty cell).
  product?: { name: string; sku: string | null } | null;
  variant?: { id: string; title: string; titleAr: string | null } | null;
  qty: number;
  qtyReceived: number;
  unitCost: number; // piastres
}

interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  expectedDate: string | null;
  receivedDate: string | null;
  totalCost: number; // piastres
  createdAt: string;
  notes: string | null;
  supplier: { id: string; name: string };
  items: POItem[];
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-muted text-foreground',
  sent: 'bg-info/10 text-info-ink',
  partial: 'bg-warning/10 text-warning-ink',
  received: 'bg-success/10 text-success-ink',
  cancelled: 'bg-destructive/10 text-destructive-ink',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function PurchaseOrderDetailPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const poId = params?.poId as string;
  const t = useT('stock.purchaseOrders');
  const tDetail = useT('stock.purchaseOrders.detail');
  const isAr = useLocale() === 'ar';
  const askConfirm = useConfirm();

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
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the purchase order — reading `data?.data` double-unwrapped
    // to undefined and the detail page never loaded (#831 sweep).
    apiGet<PurchaseOrder>(`/api/v1/stores/${storeId}/purchase-orders/${poId}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data) {
          const fetched = data;
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
      .catch(() => setError(tDetail('loadFailed')));
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
      setReceiveError(tDetail('qtyRequired'));
      setReceiving(false);
      return;
    }

    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/purchase-orders/${poId}/receive`,
        { receipts }
      );
      if (apiError) {
        // Coded refusals have en/ar copy; anything else shows the API text.
        // VARIANT_REQUIRED here is the receive-time refusal of an old-shape
        // variant-less line (issue 2346) — its own copy, not the draft-time one.
        setReceiveError(
          apiError.code === 'VARIANT_INACTIVE'
            ? t('errors.VARIANT_INACTIVE')
            : apiError.code === 'VARIANT_REQUIRED'
              ? t('errors.VARIANT_REQUIRED_RECEIVE')
              : apiError.message
        );
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
    const ok = await askConfirm({
      object: tDetail('cancelObject', { number: po?.poNumber ?? '' }),
      consequence: tDetail('cancelConsequence'),
      confirmLabel: tDetail('cancelAction'),
    });
    if (!ok) return;
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

  const canReceive = !!po && ['draft', 'sent', 'partial'].includes(po.status);
  const canCancel = po?.status === 'draft';

  const itemColumns: DataTableColumn<POItem>[] = [
    {
      header: tDetail('colProduct'),
      primaryOnMobile: true,
      cell: item => (
        <span className="truncate max-w-[12rem] block">
          {item.product?.name ?? '—'}
          {item.variant && (
            <span className="block text-xs text-muted-foreground truncate">
              {(isAr && item.variant.titleAr) || item.variant.title}
            </span>
          )}
        </span>
      ),
    },
    {
      header: tDetail('colOrdered'),
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
            className={`font-mono text-xs ${remaining > 0 ? 'text-warning-ink' : 'text-muted-foreground'}`}
          >
            {remaining}
          </span>
        );
      },
    },
    {
      header: t('new.unitCost'),
      alignEnd: true,
      className: 'w-28',
      cell: item => <span className="font-mono text-xs">{minorToMajor(item.unitCost)}</span>,
    },
    {
      header: t('new.lineTotal'),
      alignEnd: true,
      hideOnMobile: true,
      className: 'w-28',
      cell: item => (
        <span className="font-mono text-xs">{minorToDecimalString(item.qty * item.unitCost)}</span>
      ),
    },
    ...(canReceive
      ? [
          {
            header: tDetail('colReceiveQty'),
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
                  className={`${FIELD_CLASSES} text-end font-mono`}
                />
              );
            },
          } satisfies DataTableColumn<POItem>,
        ]
      : []),
  ];

  return (
    <AdminLayout
      title={po?.poNumber ?? t('title')}
      subtitle={po?.supplier.name}
      parent={{ label: t('title'), href: `/stores/${storeId}/stock/purchase-orders` }}
      actions={
        po ? (
          <div className="flex items-center gap-2">
            {canCancel && (
              <RowActions
                menuLabel={tDetail('menuLabel')}
                items={[
                  {
                    label: cancelling ? tDetail('cancelling') : tDetail('cancelButton'),
                    destructive: true,
                    disabled: cancelling,
                    onSelect: handleCancel,
                  },
                ]}
              />
            )}
            {canReceive && (
              <Button onClick={handleReceive} disabled={receiving}>
                {receiving ? tDetail('receiving') : tDetail('receiveButton')}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <PageState loading={!po && !error} error={error} onRetry={loadPO}>
        {po && (
          <div className="max-w-4xl space-y-6">
            {/* Header summary */}
            <div className="flex flex-wrap gap-4 items-start">
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  STATUS_CLASSES[po.status] ?? 'bg-muted text-muted-ink'
                }`}
              >
                {t(`statuses.${po.status}`)}
              </span>

              <div className="text-sm text-muted-foreground space-x-4">
                {po.expectedDate && (
                  <span>
                    {t('expectedDate')}: {formatDate(po.expectedDate)}
                  </span>
                )}
                {po.receivedDate && (
                  <span>
                    {t('receivedDate')}: {formatDate(po.receivedDate)}
                  </span>
                )}
                <span>
                  {t('total')}: <strong>{formatPrice(po.totalCost)}</strong>
                </span>
              </div>
            </div>

            {/* Items table */}
            <div>
              <DataTable<POItem>
                ariaLabel={tDetail('itemsTableLabel')}
                columns={itemColumns}
                rows={po.items}
                rowKey={item => item.id}
              />
              {/* DataTable has no footer concept, so the total is a summary bar
              right below the table — visible on both layouts. */}
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2 mt-3 text-sm font-medium">
                <span>{tDetail('totalLabel')}</span>
                <span className="font-mono font-semibold">{formatPrice(po.totalCost)}</span>
              </div>
            </div>

            {/* Receive: the quantities are in the table; the action is the header primary. */}
            {canReceive && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{tDetail('receiveSection')}</h3>
                {receiveError && <div className="text-destructive-ink text-sm">{receiveError}</div>}
                <p className="text-xs text-muted-foreground">{tDetail('receiveHelp')}</p>
              </div>
            )}
          </div>
        )}
      </PageState>
    </AdminLayout>
  );
}
