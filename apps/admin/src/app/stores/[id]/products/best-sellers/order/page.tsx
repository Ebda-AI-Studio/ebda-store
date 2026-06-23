'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Button, useToast } from '@force/ui';
import { useLocale } from 'next-intl';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../../../lib/api';
import { useT } from '@/i18n/useT';

interface ProductRow {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  status: string;
  bestSellerPosition: number;
  images: { url: string }[];
}

export default function BestSellersOrderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('products.bestSellersOrder');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { success: toastSuccess, error: showError } = useToast();

  const fetchProducts = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{ products: ProductRow[] }>(
        `/api/v1/stores/${storeId}/products/best-sellers`
      );
      if (apiError) {
        setError(apiError.message || t('fetchFailed'));
      } else if (data) {
        setProducts(data.products);
      }
    } catch {
      setError(t('connectionError'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  function moveProduct(id: string, direction: 'up' | 'down') {
    setProducts(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx < 0) return prev;
      const swap = direction === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
    setIsDirty(true);
  }

  async function saveOrder() {
    if (!storeId || !isDirty) return;
    setIsSaving(true);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/products/best-sellers/reorder`,
        { orderedProductIds: products.map(p => p.id) }
      );
      if (apiError) {
        showError(t('saveFailed'), apiError.message ?? '');
      } else {
        toastSuccess(t('saveSuccess'));
        setIsDirty(false);
      }
    } catch {
      showError(t('saveFailed'), t('connectionError'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/products`}>
            <Button type="button" variant="outline">
              {t('backToProducts')}
            </Button>
          </Link>
          <Button
            type="button"
            onClick={saveOrder}
            disabled={!isDirty || isSaving}
            isLoading={isSaving}
          >
            {isSaving ? t('saving') : t('save')}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchProducts}>
            {t('retry')}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3 rounded-xl border bg-card p-6 shadow-sm">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 animate-pulse">
              <div className="h-12 w-12 rounded-lg bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 rounded bg-muted" />
                <div className="h-3 w-24 rounded bg-muted" />
              </div>
              <div className="flex gap-1">
                <div className="h-7 w-7 rounded-lg bg-muted" />
                <div className="h-7 w-7 rounded-lg bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 shadow-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <svg
              className="h-8 w-8 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0
                   00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0
                   00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1
                   1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1
                   1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0
                   00.951-.69l1.519-4.674z"
              />
            </svg>
          </div>
          <p className="font-semibold text-foreground">{t('empty')}</p>
          <p className="mt-1 max-w-md mx-auto text-sm text-muted-foreground">
            {t('emptyDescription')}
          </p>
          <Link href={`/stores/${storeId}/products`} className="mt-4 inline-block">
            <Button type="button" variant="outline" size="sm">
              {t('goToProducts')}
            </Button>
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          {isDirty && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
              {t('unsavedChanges')}
            </div>
          )}
          <ul className="divide-y divide-border" role="list" aria-label={t('title')}>
            {products.map((product, idx) => (
              <li
                key={product.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
              >
                {/* Drag handle indicator (visual only; move via arrow buttons) */}
                <span className="flex-shrink-0 text-muted-foreground/40 select-none" aria-hidden>
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
                    <circle cx="5" cy="4" r="1.2" />
                    <circle cx="11" cy="4" r="1.2" />
                    <circle cx="5" cy="8" r="1.2" />
                    <circle cx="11" cy="8" r="1.2" />
                    <circle cx="5" cy="12" r="1.2" />
                    <circle cx="11" cy="12" r="1.2" />
                  </svg>
                </span>

                {/* Position badge */}
                <span className="flex-shrink-0 w-6 text-center text-xs font-mono text-muted-foreground">
                  {idx + 1}
                </span>

                {/* Thumbnail */}
                {product.images[0]?.url ? (
                  <Image
                    src={product.images[0].url}
                    alt={
                      isRtl ? product.nameAr || product.name : product.name || product.nameAr || ''
                    }
                    width={48}
                    height={48}
                    className="h-12 w-12 rounded-lg object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold text-sm">
                    {(isRtl
                      ? product.nameAr || product.name
                      : product.name || product.nameAr || ''
                    ).charAt(0)}
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium text-sm text-foreground">
                    {isRtl ? product.nameAr || product.name : product.name || product.nameAr}
                  </p>
                  {(isRtl ? product.name : product.nameAr) && (
                    <p className="truncate text-xs text-muted-foreground">
                      {isRtl ? product.name : product.nameAr}
                    </p>
                  )}
                  <div className="mt-0.5 flex items-center gap-2">
                    {product.sku && (
                      <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {t('sku', { sku: product.sku })}
                      </span>
                    )}
                    {product.status !== 'active' && (
                      <span className="text-xs text-muted-foreground">{t('inactive')}</span>
                    )}
                  </div>
                </div>

                {/* Move controls */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => moveProduct(product.id, 'up')}
                    disabled={idx === 0 || isSaving}
                    aria-label={t('moveUp')}
                    title={t('moveUp')}
                    className="grid h-7 w-7 place-items-center rounded-lg border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-30"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 15l7-7 7 7"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveProduct(product.id, 'down')}
                    disabled={idx === products.length - 1 || isSaving}
                    aria-label={t('moveDown')}
                    title={t('moveDown')}
                    className="grid h-7 w-7 place-items-center rounded-lg border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-30"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            {t('productCount', { count: products.length })}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
