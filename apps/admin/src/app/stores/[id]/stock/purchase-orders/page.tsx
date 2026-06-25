'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  expectedDate: string | null;
  receivedDate: string | null;
  totalCost: number;
  createdAt: string;
  supplier: {
    id: string;
    name: string;
  };
}

interface POListResponse {
  data: PurchaseOrder[];
  meta: { total: number; page: number; perPage: number };
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

export default function PurchaseOrdersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.purchaseOrders');
  const tc = useT('common');

  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Debounced search term — client-side filter over PO number and supplier name.
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!storeId) return;
    apiGet<POListResponse>(`/api/v1/stores/${storeId}/purchase-orders?perPage=50`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setOrders(data?.data ?? []);
        }
      })
      .catch(() => setError('Failed to load purchase orders'));
  }, [storeId]);

  // Client-side filter: match PO number or supplier name (case-insensitive).
  // Must be declared before early returns so hooks run unconditionally.
  const filteredOrders = useMemo(() => {
    if (!orders) return null;
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(
      po => po.poNumber.toLowerCase().includes(q) || po.supplier.name.toLowerCase().includes(q)
    );
  }, [orders, search]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!orders) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            value={search}
            onSearch={setSearch}
            placeholder={t('searchPlaceholder')}
            className="w-full sm:w-64"
          />
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/purchase-orders/new`)}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
          >
            {t('newButton')}
          </button>
        </div>

        {filteredOrders !== null && filteredOrders.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No purchase orders yet. Create one with the button above.
          </p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('poNumber')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                    {t('supplier')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('status')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('expectedDate')}
                  </th>
                  <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('total')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('createdDate')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(filteredOrders ?? []).map(po => (
                  <tr
                    key={po.id}
                    className="border-t border-border/40 cursor-pointer hover:bg-muted/20 transition-colors"
                    onClick={() => router.push(`/stores/${storeId}/stock/purchase-orders/${po.id}`)}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{po.poNumber}</td>
                    <td className="px-3 py-2 truncate max-w-[10rem]">{po.supplier.name}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          STATUS_CLASSES[po.status] ?? 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {t(`statuses.${po.status}`)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-end font-mono text-xs font-semibold">
                      {filsToKwd(po.totalCost)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(po.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
