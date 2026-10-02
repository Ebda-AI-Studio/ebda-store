'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { DataTable } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGetPage, type PageMeta } from '@/lib/api';
import { PageControls } from '@/components/PageControls';
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

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-muted text-foreground',
  sent: 'bg-info/10 text-info-ink',
  partial: 'bg-warning/10 text-warning-ink',
  received: 'bg-success/10 text-success-ink',
  cancelled: 'bg-destructive/10 text-destructive-ink',
};

const PER_PAGE = 50;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PurchaseOrdersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.purchaseOrders');
  const tc = useT('common');

  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Debounced search term — matched SERVER-side over PO number and supplier name, so it reaches
  // every PO and not just the first page (issue 2430).
  const [search, setSearch] = useState('');
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);

  // A new search is a new list: start it on page 1.
  useEffect(() => {
    setPage(1);
  }, [search]);

  useEffect(() => {
    if (!storeId) return;
    let stale = false;
    const qs = new URLSearchParams({ perPage: String(PER_PAGE), page: String(page) });
    if (search.trim()) qs.set('q', search.trim());
    // `apiGetPage` keeps the route's `meta` (total + pages) that `apiGet` drops.
    apiGetPage<PurchaseOrder>(`/api/v1/stores/${storeId}/purchase-orders?${qs}`)
      .then(({ data, meta: pageMeta, error: apiError }) => {
        if (stale) return; // a slower response for the previous search must not repaint
        if (apiError) {
          setError(apiError.message);
        } else {
          setError(null);
          setOrders(data ?? []);
          setMeta(pageMeta);
        }
      })
      .catch(() => {
        if (!stale) setError('Failed to load purchase orders');
      });
    return () => {
      stale = true;
    };
  }, [storeId, page, search]);

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

        {meta && (
          <p className="text-sm text-muted-foreground" data-testid="po-total">
            {t('totalCount', { total: meta.total.toLocaleString() })}
          </p>
        )}

        <DataTable<PurchaseOrder>
          ariaLabel={t('title')}
          columns={[
            {
              header: t('poNumber'),
              primaryOnMobile: true,
              className: 'w-28',
              cell: po => <span className="font-mono text-xs">{po.poNumber}</span>,
            },
            {
              header: t('supplier'),
              cell: po => <span className="truncate max-w-[10rem] block">{po.supplier.name}</span>,
            },
            {
              header: t('status'),
              mobileBadge: true,
              className: 'w-28',
              cell: po => (
                <span
                  className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    STATUS_CLASSES[po.status] ?? 'bg-muted text-muted-ink'
                  }`}
                >
                  {t(`statuses.${po.status}`)}
                </span>
              ),
            },
            {
              header: t('expectedDate'),
              className: 'w-28',
              cell: po => (
                <span className="text-muted-foreground">
                  {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString() : '—'}
                </span>
              ),
            },
            {
              header: t('total'),
              alignEnd: true,
              className: 'w-28',
              cell: po => (
                <span className="font-mono text-xs font-semibold">{filsToKwd(po.totalCost)}</span>
              ),
            },
            {
              header: t('createdDate'),
              hideOnMobile: true,
              className: 'w-28',
              cell: po => (
                <span className="text-muted-foreground">
                  {new Date(po.createdAt).toLocaleDateString()}
                </span>
              ),
            },
          ]}
          rows={orders}
          rowKey={po => po.id}
          onRowClick={po => router.push(`/stores/${storeId}/stock/purchase-orders/${po.id}`)}
          emptyState={<p className="text-muted-foreground text-sm">{t('emptyState')}</p>}
        />
        <PageControls meta={meta} onPageChange={setPage} />
      </div>
    </AdminLayout>
  );
}
