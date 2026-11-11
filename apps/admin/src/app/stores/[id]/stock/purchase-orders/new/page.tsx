'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { FormFooter } from '@/components/FormFooter';
import { PageState } from '@/components/PageState';
import { apiGet, apiPost } from '@/lib/api';
import { isVariantProduct } from '@/lib/variant-product';
import { formatPrice } from '@/lib/format';

import { roundToMinor } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';
// ─── Types ────────────────────────────────────────────────────────────────────

interface SupplierOption {
  id: string;
  name: string;
}

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  hasVariants?: boolean;
  variantCount?: number;
}

interface VariantOption {
  id: string;
  title: string;
  titleAr?: string | null;
  sku?: string | null;
  isActive?: boolean;
}

interface ProductsResponse {
  products: ProductOption[];
  meta: { total: number };
}

interface POLineItem {
  productId: string;
  // Required when the product has variants: stock lives on the variant, and a
  // variant-less line is refused by the API (inventory-model.md, 2026-10-01).
  variantId: string;
  qty: string;
  unitCost: string; // EGP (user types major units; converted to piastres on save)
}

interface POCreated {
  id: string;
  poNumber: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_LINE: POLineItem = { productId: '', variantId: '', qty: '', unitCost: '' };

// Returns line total in PIASTRES (qty × unitCost-in-EGP × 100)
function lineTotal(line: POLineItem): number {
  const qty = parseInt(line.qty) || 0;
  const costFils = roundToMinor(parseFloat(line.unitCost) || 0);
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
  // Variants per product id, fetched when a variant product is picked.
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, VariantOption[]>>({});
  const isAr = useLocale() === 'ar';
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [notesAr, setNotesAr] = useState('');
  const [lines, setLines] = useState<POLineItem[]>([{ ...EMPTY_LINE }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    // Load active suppliers. apiGet already unwraps the API's
    // `{ success, data }` envelope, so `data` IS the supplier array —
    // reading `data.data` double-unwrapped to undefined and the dropdown
    // was always empty (#831 sweep).
    // A failed load must not look like "no suppliers" (CU-1): PageState shows the error with a retry.
    setLoadState('loading');
    Promise.all([
      apiGet<SupplierOption[]>(`/api/v1/stores/${storeId}/suppliers?isActive=true`),
      apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?limit=200`),
    ])
      .then(([sup, prod]) => {
        if (sup.error || prod.error) {
          setLoadState('error');
          return;
        }
        setSuppliers(sup.data ?? []);
        setProducts(prod.data?.products ?? []);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  }, [storeId, reloadKey]);

  function updateLine(i: number, patch: Partial<POLineItem>) {
    setLines(cur => cur.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  }

  function productHasVariants(productId: string): boolean {
    return isVariantProduct(products.find(p => p.id === productId));
  }

  function selectProduct(i: number, productId: string) {
    updateLine(i, { productId, variantId: '' });
    if (!productId || !productHasVariants(productId) || variantsByProduct[productId]) return;
    // The endpoint returns `{ product, options, variants }` with the variants
    // at the TOP level (same shape the orders/new picker reads).
    apiGet<{ variants: VariantOption[] }>(
      `/api/v1/stores/${storeId}/products/${productId}/variants`
    ).then(({ data }) => {
      setVariantsByProduct(cur => ({
        ...cur,
        // A disabled variant is not stock (inventory-model.md) — not orderable here.
        [productId]: (data?.variants ?? []).filter(v => v.isActive !== false),
      }));
    });
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
      header: tNew('colProduct'),
      primaryOnMobile: true,
      cell: (line, i) => (
        <select
          value={line.productId}
          onChange={e => selectProduct(i, e.target.value)}
          className={FIELD_CLASSES}
        >
          <option value="">— {tNew('selectProduct')} —</option>
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
      header: tNew('variant'),
      className: 'w-44',
      cell: (line, i) => {
        // Only a product WITH variants gets a picker; a plain product's line
        // has no variant to name.
        if (!line.productId || !productHasVariants(line.productId)) return null;
        return (
          <select
            value={line.variantId}
            onChange={e => updateLine(i, { variantId: e.target.value })}
            className={FIELD_CLASSES}
            aria-invalid={!line.variantId}
          >
            <option value="">— {tNew('selectVariant')} —</option>
            {(variantsByProduct[line.productId] ?? []).map(v => (
              <option key={v.id} value={v.id}>
                {v.sku ? `[${v.sku}] ` : ''}
                {(isAr && v.titleAr) || v.title}
              </option>
            ))}
          </select>
        );
      },
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
          className={`${FIELD_CLASSES} text-end font-mono`}
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
          step="0.01"
          value={line.unitCost}
          onChange={e => updateLine(i, { unitCost: e.target.value })}
          className={`${FIELD_CLASSES} text-end font-mono`}
          placeholder="0.00"
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
        <Button
          type="button"
          onClick={() => removeLine(i)}
          disabled={lines.length <= 1}
          variant="link"
          size="sm"
          className="text-destructive-ink"
        >
          ✕
        </Button>
      ),
    },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supplierId) {
      setError(tNew('supplierRequired'));
      return;
    }
    const validLines = lines.filter(l => l.productId && l.qty && l.unitCost);
    if (validLines.length === 0) {
      setError(tNew('linesRequired'));
      return;
    }
    if (validLines.some(l => productHasVariants(l.productId) && !l.variantId)) {
      setError(tNew('variantRequired'));
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
        variantId: l.variantId || undefined,
        qty: parseInt(l.qty),
        unitCost: roundToMinor(parseFloat(l.unitCost) || 0), // convert EGP → piastres
      })),
    };

    try {
      const { data, error: apiError } = await apiPost<POCreated>(
        `/api/v1/stores/${storeId}/purchase-orders`,
        payload
      );
      if (apiError) {
        // Coded refusals have en/ar copy; anything else shows the API text.
        setError(
          apiError.code === 'VARIANT_INACTIVE'
            ? t('errors.VARIANT_INACTIVE')
            : apiError.code === 'VARIANT_REQUIRED'
              ? t('errors.VARIANT_REQUIRED')
              : apiError.code === 'VARIANT_PRODUCT_MISMATCH'
                ? t('errors.VARIANT_PRODUCT_MISMATCH')
                : apiError.message
        );
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
    <AdminLayout
      title={tNew('title')}
      parent={{ label: t('title'), href: `/stores/${storeId}/stock/purchase-orders` }}
    >
      <PageState
        loading={loadState === 'loading'}
        error={loadState === 'error' ? tNew('loadFailed') : null}
        onRetry={() => setReloadKey(k => k + 1)}
      >
        <form onSubmit={handleSubmit} className="max-w-4xl space-y-5">
          {/* Supplier + Expected date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-sm font-medium">
                {t('supplier')} <span className="text-destructive-ink">*</span>
              </span>
              <select
                value={supplierId}
                onChange={e => setSupplierId(e.target.value)}
                required
                className={FIELD_CLASSES}
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
                className={FIELD_CLASSES}
              />
            </label>
          </div>

          {/* Notes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-sm font-medium">{tNew('notesLabel')}</span>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                className={`${TEXTAREA_CLASSES} resize-none`}
                placeholder={tNew('notesPlaceholder')}
              />
            </label>
            <label className="space-y-1" dir="rtl">
              <span className="text-sm font-medium">{tNew('notesArLabel')}</span>
              <textarea
                value={notesAr}
                onChange={e => setNotesAr(e.target.value)}
                rows={2}
                dir="rtl"
                className={`${TEXTAREA_CLASSES} resize-none`}
                placeholder={t('notesArPlaceholder')}
              />
            </label>
          </div>

          {/* Line items */}
          <div>
            <DataTable<POLineItem>
              ariaLabel={tNew('lineItemsTableLabel')}
              columns={lineColumns}
              rows={lines}
              rowKey={(_l, i) => String(i)}
            />
            {/* DataTable has no footer concept, so the subtotal is a summary bar
              right below the table — visible on both layouts. */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2 mt-3 text-sm font-medium">
              <span>{tNew('subtotal')}</span>
              <span className="font-mono font-semibold">{formatPrice(subtotalFils)}</span>
            </div>
          </div>

          <div>
            <Button type="button" onClick={addLine} variant="outline" size="sm">
              {tNew('addItem')}
            </Button>
          </div>

          {error && (
            <div role="alert" className="text-destructive-ink text-sm">
              {error}
            </div>
          )}

          <FormFooter
            primaryLabel={tNew('submit')}
            cancelHref={`/stores/${storeId}/stock/purchase-orders`}
            saving={submitting}
          />
        </form>
      </PageState>
    </AdminLayout>
  );
}
