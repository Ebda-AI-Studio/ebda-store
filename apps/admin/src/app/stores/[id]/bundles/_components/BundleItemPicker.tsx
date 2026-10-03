'use client';

/**
 * Product + quantity picker for the bundle editor.
 *
 * Mirrors the product-search-then-variant-picker flow in
 * `stores/[id]/orders/new/page.tsx` (search-as-you-type -> inline variant
 * chooser for products with variants -> line-item list with a quantity
 * input) rather than `ScopePicker` (promotions/coupons' multi-select),
 * because a bundle component needs a QUANTITY per line and a per-line
 * price/stock snapshot that a plain id-list scope picker has no room for.
 *
 * Each row carries everything the page needs for the three live-preview
 * requirements (component sum, derived price, derived availability)
 * without a second round-trip: `unitPrice` (mirrors
 * `cartLineUnitPrice` — variant price override falls back to the parent
 * product's price), `trackInventory` (from the PARENT product — variants
 * have no inventory-tracking flag of their own, see
 * `apps/api/src/services/bundle.service.ts`'s `resolveBundle`), and
 * `availableStock` (the pinned variant's own inventory, or the product's
 * variant-aware `totalInventory` when no specific variant is pinned).
 *
 * Fix round 1: variant fetches go through `extractVariantOptions`
 * (`../bundlePricing`) rather than reading `data.product.variants` inline —
 * see that function's doc comment for the bug this fixes.
 */

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../lib/api';
import { formatPrice } from '@/lib/format';
import { extractVariantOptions } from '../bundlePricing';

// Mirrors bundle.routes.ts's MAX_BUNDLE_ITEMS — not importable from the
// admin app (apps/api is a separate deployable); the server is the real
// enforcement, this only stops the merchant from typing past a limit that
// would 400 on save.
const MAX_BUNDLE_ITEMS = 50;

export interface BundleItemRow {
  productId: string;
  variantId?: string | null;
  /** Locale-resolved display name (product, or "product — variant"). */
  name: string;
  /** piastres */
  unitPrice: number;
  quantity: number;
  trackInventory: boolean;
  /** Effective stock for THIS line specifically (see file header). */
  availableStock: number;
}

interface ProductVariantResult {
  id: string;
  title: string;
  titleAr?: string | null;
  price: number | null;
  inventory: number;
  isActive: boolean;
}

interface ProductSearchResult {
  id: string;
  name: string;
  nameAr?: string | null;
  price: number;
  sku?: string | null;
  hasVariants?: boolean;
  trackInventory: boolean;
  totalInventory: number;
}

interface BundleItemPickerProps {
  storeId: string;
  value: BundleItemRow[];
  onChange: (items: BundleItemRow[]) => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

export function BundleItemPicker({ storeId, value, onChange }: BundleItemPickerProps) {
  const t = useT('bundles.itemPicker');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [pendingVariantProduct, setPendingVariantProduct] = useState<ProductSearchResult | null>(
    null
  );
  const [variantOptions, setVariantOptions] = useState<ProductVariantResult[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);

  const debouncedSearch = useDebounced(search, 250);
  const atLimit = value.length >= MAX_BUNDLE_ITEMS;

  const displayName = (name: string, nameAr?: string | null) =>
    isRtl ? nameAr || name : name || nameAr || name;

  useEffect(() => {
    if (atLimit || debouncedSearch.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    apiGet<{ products: ProductSearchResult[] }>(
      `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(debouncedSearch)}&limit=10`
    ).then(({ data }) => {
      if (!cancelled && data?.products) setResults(data.products);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId, debouncedSearch, atLimit]);

  function addLine(row: BundleItemRow) {
    const existing = value.find(
      it => it.productId === row.productId && (it.variantId ?? null) === (row.variantId ?? null)
    );
    if (existing) {
      onChange(
        value.map(it =>
          it === existing ? { ...it, quantity: Math.min(1000, it.quantity + 1) } : it
        )
      );
      return;
    }
    onChange([...value, row]);
  }

  async function selectProduct(p: ProductSearchResult) {
    setSearch('');
    setResults([]);
    if (!p.hasVariants) {
      addLine({
        productId: p.id,
        variantId: null,
        name: displayName(p.name, p.nameAr),
        unitPrice: p.price,
        quantity: 1,
        trackInventory: p.trackInventory,
        availableStock: p.totalInventory,
      });
      return;
    }

    setLoadingVariants(true);
    try {
      const { data } = await apiGet<{ variants: ProductVariantResult[] }>(
        `/api/v1/stores/${storeId}/products/${p.id}/variants`
      );
      setVariantOptions(extractVariantOptions(data));
      setPendingVariantProduct(p);
    } finally {
      setLoadingVariants(false);
    }
  }

  function selectVariant(product: ProductSearchResult, variant: ProductVariantResult) {
    const variantName = isRtl ? variant.titleAr || variant.title : variant.title;
    addLine({
      productId: product.id,
      variantId: variant.id,
      name: `${displayName(product.name, product.nameAr)} — ${variantName}`,
      unitPrice: variant.price ?? product.price,
      quantity: 1,
      trackInventory: product.trackInventory,
      availableStock: variant.inventory,
    });
    setPendingVariantProduct(null);
    setVariantOptions([]);
  }

  function removeLine(row: BundleItemRow) {
    onChange(value.filter(it => it !== row));
  }

  function setQuantity(row: BundleItemRow, quantity: number) {
    // DB CHECK + Zod both bound quantity to [1, 1000] — clamp client-side so
    // a merchant typing "0" or "5000" sees the real ceiling immediately
    // instead of a 400 after save.
    const clamped = Math.max(1, Math.min(1000, Math.round(quantity) || 1));
    onChange(value.map(it => (it === row ? { ...it, quantity: clamped } : it)));
  }

  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-foreground">{t('heading')}</span>

      {atLimit ? (
        <p className="text-xs text-muted-foreground">
          {t('limitReached', { max: MAX_BUNDLE_ITEMS })}
        </p>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {results.length > 0 && (
            <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-background shadow-lg">
              {results.map(p => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void selectProduct(p)}
                    className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                  >
                    <span className="font-medium">{displayName(p.name, p.nameAr)}</span>
                    <span className="ms-2 text-muted-foreground">{formatPrice(p.price)}</span>
                    {p.trackInventory && (
                      <span className="ms-2 text-xs text-muted-foreground">
                        {t('stockCount', { count: p.totalInventory })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {loadingVariants && (
            <p className="mt-2 text-xs text-muted-foreground">{t('loadingVariants')}</p>
          )}
          {pendingVariantProduct && (
            <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">
                {t('chooseVariant', {
                  product: displayName(pendingVariantProduct.name, pendingVariantProduct.nameAr),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                {variantOptions
                  .filter(v => v.isActive)
                  .map(v => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => selectVariant(pendingVariantProduct, v)}
                      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:border-primary/40 hover:bg-primary/5"
                    >
                      {isRtl ? v.titleAr || v.title : v.title}
                      <span className="ms-1.5 text-muted-foreground">
                        {formatPrice(v.price ?? pendingVariantProduct.price)}
                      </span>
                    </button>
                  ))}
              </div>
              <button
                type="button"
                onClick={() => setPendingVariantProduct(null)}
                className="mt-2 text-xs text-muted-foreground underline"
              >
                {t('cancelVariant')}
              </button>
            </div>
          )}
        </div>
      )}

      {value.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {value.map(row => (
            <li
              key={`${row.productId}-${row.variantId ?? 'base'}`}
              className="flex items-center gap-3 p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">{row.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatPrice(row.unitPrice)}
                  {' · '}
                  {row.trackInventory
                    ? t('stockCount', { count: row.availableStock })
                    : t('notTracked')}
                </p>
              </div>
              <input
                type="number"
                min={1}
                max={1000}
                value={row.quantity}
                onChange={e => setQuantity(row, Number(e.target.value))}
                aria-label={t('quantityLabel')}
                className="w-16 rounded border border-border bg-background px-2 py-1 text-center text-sm"
              />
              <span className="w-24 text-end font-semibold text-foreground">
                {formatPrice(row.unitPrice * row.quantity)}
              </span>
              <button
                type="button"
                onClick={() => removeLine(row)}
                aria-label={t('removeLabel')}
                className="rounded p-1 text-destructive-ink hover:bg-destructive/10"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
