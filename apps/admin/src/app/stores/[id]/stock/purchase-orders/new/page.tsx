'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SupplierOption {
  id: string;
  name: string;
}

interface SuppliersResponse {
  data: SupplierOption[];
}

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
}

interface ProductsResponse {
  products: ProductOption[];
  meta: { total: number };
}

interface POLineItem {
  productId: string;
  qty: string;
  unitCost: string; // KWD (user types dinar; converted to fils on save)
}

interface POCreated {
  id: string;
  poNumber: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_LINE: POLineItem = { productId: '', qty: '', unitCost: '' };

// Returns line total in FILS (qty × unitCost-in-dinar × 1000)
function lineTotal(line: POLineItem): number {
  const qty = parseInt(line.qty) || 0;
  const costFils = Math.round((parseFloat(line.unitCost) || 0) * 1000);
  return qty * costFils;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewPurchaseOrderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.purchaseOrders');
  const tNew = useT('stock.purchaseOrders.new');

  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [notesAr, setNotesAr] = useState('');
  const [lines, setLines] = useState<POLineItem[]>([{ ...EMPTY_LINE }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    // Load active suppliers
    apiGet<SuppliersResponse>(`/api/v1/stores/${storeId}/suppliers?isActive=true`).then(
      ({ data }) => {
        if (data) setSuppliers(data.data ?? []);
      }
    );
    // Load products for line item selects
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?limit=200`).then(({ data }) => {
      if (data) setProducts(data.products ?? []);
    });
  }, [storeId]);

  function updateLine(i: number, patch: Partial<POLineItem>) {
    setLines(cur => cur.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines(cur => [...cur, { ...EMPTY_LINE }]);
  }

  function removeLine(i: number) {
    setLines(cur => (cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  const subtotalFils = lines.reduce((acc, l) => acc + lineTotal(l), 0);

  const lineColumns: DataTableColumn<POLineItem>[] = [
    {
      header: 'Product',
      primaryOnMobile: true,
      cell: (line, i) => (
        <select
          value={line.productId}
          onChange={e => updateLine(i, { productId: e.target.value })}
          className="w-full border border-border rounded px-2 py-1 text-base sm:text-sm"
        >
          <option value="">— Select product —</option>
          {products.map(p => (
            <option key={p.id} value={p.id}>
              {p.sku ? `[${p.sku}] ` : ''}
              {p.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      header: tNew('qty'),
      alignEnd: true,
      className: 'w-24',
      cell: (line, i) => (
        <input
          type="number"
          min="1"
          step="1"
          value={line.qty}
          onChange={e => updateLine(i, { qty: e.target.value })}
          className="w-full border border-border rounded px-2 py-1 text-end font-mono text-base sm:text-sm"
          placeholder="1"
        />
      ),
    },
    {
      header: tNew('unitCost'),
      alignEnd: true,
      className: 'w-36',
      cell: (line, i) => (
        <input
          type="number"
          min="0"
          step="0.001"
          value={line.unitCost}
          onChange={e => updateLine(i, { unitCost: e.target.value })}
          className="w-full border border-border rounded px-2 py-1 text-end font-mono text-base sm:text-sm"
          placeholder="0.000"
        />
      ),
    },
    {
      header: tNew('lineTotal'),
      alignEnd: true,
      className: 'w-32',
      cell: line => {
        const lt = lineTotal(line);
        return (
          <span className="font-mono text-xs text-muted-foreground">
            {lt > 0 ? formatPrice(lt) : '—'}
          </span>
        );
      },
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      className: 'w-10 text-center',
      cell: (_line, i) => (
        <button
          type="button"
          onClick={() => removeLine(i)}
          disabled={lines.length <= 1}
          className="text-red-600 disabled:opacity-30 hover:underline text-xs max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-2"
        >
          ✕
        </button>
      ),
    },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supplierId) {
      setError('Please select a supplier.');
      return;
    }
    const validLines = lines.filter(l => l.productId && l.qty && l.unitCost);
    if (validLines.length === 0) {
      setError('Add at least one line item with product, quantity, and unit cost.');
      return;
    }
    setSubmitting(true);
    setError(null);

    const payload = {
      supplierId,
      expectedDate: expectedDate || undefined,
      notes: notes.trim() || undefined,
      notesAr: notesAr.trim() || undefined,
      items: validLines.map(l => ({
        productId: l.productId,
        qty: parseInt(l.qty),
        unitCost: Math.round((parseFloat(l.unitCost) || 0) * 1000), // convert KWD → fils
      })),
    };

    try {
      const { data, error: apiError } = await apiPost<POCreated>(
        `/api/v1/stores/${storeId}/purchase-orders`,
        payload
      );
      if (apiError) {
        setError(apiError.message);
        return;
      }
      if (data?.id) {
        router.push(`/stores/${storeId}/stock/purchase-orders/${data.id}`);
      } else {
        router.push(`/stores/${storeId}/stock/purchase-orders`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={tNew('title')}>
      <form onSubmit={handleSubmit} className="max-w-4xl space-y-5">
        {/* Supplier + Expected date */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">
              {t('supplier')} <span className="text-red-500">*</span>
            </span>
            <select
              value={supplierId}
              onChange={e => setSupplierId(e.target.value)}
              required
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            >
              <option value="">— {tNew('selectSupplier')} —</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium">{tNew('expectedDateLabel')}</span>
            <input
              type="date"
              value={expectedDate}
              onChange={e => setExpectedDate(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            />
          </label>
        </div>

        {/* Notes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">Notes (English)</span>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              placeholder="Optional notes"
            />
          </label>
          <label className="space-y-1" dir="rtl">
            <span className="text-sm font-medium">ملاحظات (عربي)</span>
            <textarea
              value={notesAr}
              onChange={e => setNotesAr(e.target.value)}
              rows={2}
              dir="rtl"
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              placeholder="ملاحظات بالعربية (اختياري)"
            />
          </label>
        </div>

        {/* Line items */}
        <div>
          <DataTable<POLineItem> columns={lineColumns} rows={lines} rowKey={(_l, i) => String(i)} />
          {/* DataTable has no footer concept, so the subtotal is a summary bar
              right below the table — visible on both layouts. */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2 mt-3 text-sm font-medium">
            <span>{tNew('subtotal')}</span>
            <span className="font-mono font-semibold">{formatPrice(subtotalFils)}</span>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={addLine}
            className="px-3 py-1.5 border border-border rounded text-sm"
          >
            {tNew('addItem')}
          </button>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        <div className="flex gap-2 flex-wrap">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
          >
            {submitting ? 'Saving…' : tNew('submit')}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/purchase-orders`)}
            className="px-4 py-2 border border-border rounded text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </AdminLayout>
  );
}
