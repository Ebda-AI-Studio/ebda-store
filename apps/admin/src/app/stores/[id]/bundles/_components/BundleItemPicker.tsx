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

import { useCallback, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../lib/api';
import { isVariantProduct } from '../../../../../lib/variant-product';
import { formatPrice } from '@/lib/format';
import { extractVariantOptions } from '../bundlePricing';
import { SearchPicker } from '@/components/SearchPicker';

import { Button } from '@/components/ui/Button';
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
  variantCount?: number;
  trackInventory: boolean;
  totalInventory: number;
}

interface BundleItemPickerProps {
  storeId: string;
  value: BundleItemRow[];
  onChange: (items: BundleItemRow[]) => void;
}

export function BundleItemPicker({ storeId, value, onChange }: BundleItemPickerProps) {
  const t = useT('bundles.itemPicker');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const [pendingVariantProduct, setPendingVariantProduct] = useState<ProductSearchResult | null>(
    null
  );
  const [variantOptions, setVariantOptions] = useState<ProductVariantResult[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);

  const atLimit = value.length >= MAX_BUNDLE_ITEMS;

  const displayName = (name: string, nameAr?: string | null) =>
    isRtl ? nameAr || name : name || nameAr || name;

  const searchProducts = useCallback(
    async (q: string, signal: AbortSignal) => {
      const { data, error } = await apiGet<{ products: ProductSearchResult[] }>(
        `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=10`,
        undefined,
        signal
      );
      if (error) throw new Error(error.message);
      return data?.products ?? [];
    },
    [storeId]
  );

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
    if (!isVariantProduct(p)) {
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
          <SearchPicker<ProductSearchResult>
            search={searchProducts}
            getKey={p => p.id}
            onPick={p => void selectProduct(p)}
            placeholder={t('searchPlaceholder')}
            renderOption={(p, hl) => (
              <>
                <span className="font-medium">{hl(displayName(p.name, p.nameAr))}</span>
                <span className="ms-2 text-muted-foreground">{formatPrice(p.price)}</span>
                {p.trackInventory && (
                  <span className="ms-2 text-xs text-muted-foreground">
                    {t('stockCount', { count: p.totalInventory })}
                  </span>
                )}
              </>
            )}
          />
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
                    <Button
                      key={v.id}
                      type="button"
                      onClick={() => selectVariant(pendingVariantProduct, v)}
                      variant="outline"
                      size="sm"
                    >
                      {isRtl ? v.titleAr || v.title : v.title}
                      <span className="ms-1.5 text-muted-foreground">
                        {formatPrice(v.price ?? pendingVariantProduct.price)}
                      </span>
                    </Button>
                  ))}
              </div>
              <Button
                type="button"
                onClick={() => setPendingVariantProduct(null)}
                variant="link"
                size="sm"
                className="mt-2 text-muted-foreground"
              >
                {t('cancelVariant')}
              </Button>
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
              <Button
                type="button"
                onClick={() => removeLine(row)}
                aria-label={t('removeLabel')}
                className="text-destructive-ink"
                variant="ghost"
                size="icon-sm"
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
