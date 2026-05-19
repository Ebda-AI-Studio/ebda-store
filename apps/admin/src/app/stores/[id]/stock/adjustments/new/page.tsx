'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
}

interface ProductsResponse {
  products: ProductOption[];
  meta: { total: number };
}

interface ItemDraft {
  productId: string;
  newQty: string;
}

interface AdjustmentCreated {
  id: string;
  status: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ADJUSTMENT_TYPES = [
  'cycle_count',
  'damage',
  'theft',
  'loss',
  'write_off',
  'found',
  'return_to_supplier',
] as const;

const EMPTY_ITEM: ItemDraft = { productId: '', newQty: '' };

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewStockAdjustmentPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT('stock.adjustments');
  const tNew = useT('stock.adjustments.new');

  // Pre-fill from query params (linked from inventory page)
  const prefillProductId = searchParams?.get('productId') ?? '';
  const prefillNewQty = searchParams?.get('newQty') ?? '';

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [type, setType] = useState<string>('cycle_count');
  const [reason, setReason] = useState('');
  const [reasonAr, setReasonAr] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [items, setItems] = useState<ItemDraft[]>([
    prefillProductId ? { productId: prefillProductId, newQty: prefillNewQty } : { ...EMPTY_ITEM },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?limit=200`).then(({ data }) => {
      if (data) setProducts(data.products ?? []);
    });
  }, [storeId]);

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems(cur => cur.map((item, idx) => (idx === i ? { ...item, ...patch } : item)));
  }

  function addItem() {
    setItems(cur => [...cur, { ...EMPTY_ITEM }]);
  }

  function removeItem(i: number) {
    setItems(cur => (cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  async function submitDraft() {
    setError(null);
    const validItems = items.filter(it => it.productId && it.newQty !== '');
    if (validItems.length === 0) {
      setError('Add at least one product with a quantity.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        type,
        reason: reason || undefined,
        reasonAr: reasonAr || undefined,
        evidenceUrl: evidenceUrl || undefined,
        items: validItems.map(it => ({
          productId: it.productId,
          newQty: Math.max(0, parseInt(it.newQty) || 0),
        })),
      };
      const { error: apiError } = await apiPost<AdjustmentCreated>(
        `/api/v1/stores/${storeId}/stock-adjustments`,
        payload
      );
      if (apiError) {
        setError(apiError.message);
        return;
      }
      router.push(`/stores/${storeId}/stock/adjustments`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPost() {
    setError(null);
    const validItems = items.filter(it => it.productId && it.newQty !== '');
    if (validItems.length === 0) {
      setError('Add at least one product with a quantity.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        type,
        reason: reason || undefined,
        reasonAr: reasonAr || undefined,
        evidenceUrl: evidenceUrl || undefined,
        items: validItems.map(it => ({
          productId: it.productId,
          newQty: Math.max(0, parseInt(it.newQty) || 0),
        })),
      };
      const { data, error: createError } = await apiPost<AdjustmentCreated>(
        `/api/v1/stores/${storeId}/stock-adjustments`,
        payload
      );
      if (createError) {
        setError(createError.message);
        return;
      }
      if (!data?.id) {
        setError('Unexpected response from server.');
        return;
      }
      const { error: postError } = await apiPost(
        `/api/v1/stores/${storeId}/stock-adjustments/${data.id}/post`,
        {}
      );
      if (postError) {
        setError(`Created draft ${data.id} but posting failed: ${postError.message}`);
        return;
      }
      router.push(`/stores/${storeId}/stock/adjustments`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={tNew('title')} subtitle={tNew('description')}>
      <div className="max-w-4xl space-y-5">
        {/* Type */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">{tNew('typeLabel')}</span>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="w-full max-w-xs border border-border rounded px-3 py-2 text-base sm:text-sm"
          >
            {ADJUSTMENT_TYPES.map(at => (
              <option key={at} value={at}>
                {t(`types.${at}`)}
              </option>
            ))}
          </select>
        </label>

        {/* Reason + ReasonAr */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">{tNew('reasonLabel')}</span>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              placeholder="Optional reason in English"
            />
          </label>
          <label className="space-y-1" dir="rtl">
            <span className="text-sm font-medium">{tNew('reasonArLabel')}</span>
            <textarea
              value={reasonAr}
              onChange={e => setReasonAr(e.target.value)}
              rows={3}
              dir="rtl"
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              placeholder="سبب التسوية بالعربية (اختياري)"
            />
          </label>
        </div>

        {/* Evidence URL */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">{tNew('evidenceLabel')}</span>
          <input
            type="url"
            value={evidenceUrl}
            onChange={e => setEvidenceUrl(e.target.value)}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            placeholder="https://… (paste R2 upload URL; file uploader coming in Batch 3)"
          />
        </label>

        {/* Items table */}
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                  {tNew('selectProduct')}
                </th>
                <th className="text-end px-3 py-2 w-36 font-medium text-muted-foreground">
                  {tNew('newQty')}
                </th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="px-3 py-2">
                    <select
                      value={item.productId}
                      onChange={e => updateItem(i, { productId: e.target.value })}
                      className="w-full border border-border rounded px-2 py-1 text-base sm:text-sm"
                    >
                      <option value="">— {tNew('selectProduct')} —</option>
                      {products.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.sku ? `[${p.sku}] ` : ''}
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={item.newQty}
                      onChange={e => updateItem(i, { newQty: e.target.value })}
                      className="w-full border border-border rounded px-2 py-1 text-end font-mono text-base sm:text-sm"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => removeItem(i)}
                      disabled={items.length <= 1}
                      className="text-red-600 disabled:opacity-30 hover:underline text-xs"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add product row */}
        <div>
          <button
            type="button"
            onClick={addItem}
            className="px-3 py-1.5 border border-border rounded text-sm"
          >
            {tNew('addItem')}
          </button>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        {/* Submit buttons */}
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={submitDraft}
            disabled={submitting}
            className="px-4 py-2 border border-border rounded text-sm disabled:opacity-50"
          >
            {submitting ? 'Saving…' : tNew('submitDraft')}
          </button>
          <button
            type="button"
            onClick={submitPost}
            disabled={submitting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
          >
            {submitting ? 'Saving…' : tNew('submitPost')}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/adjustments`)}
            className="px-4 py-2 border border-border rounded text-sm"
          >
            {/* Cancel */}
            Cancel
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          Posting is irreversible — it applies inventory mutations and posts a GL journal entry.
          Save as draft to review first.
        </p>
      </div>
    </AdminLayout>
  );
}
