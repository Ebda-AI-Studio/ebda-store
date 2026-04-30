'use client';

import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@force/ui';
import { formatPrice } from '../../../../../lib/format';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { StatusBadge } from './StatusBadge';
import { EmptyProductsState } from './EmptyProductsState';
import type { Product } from './types';

interface ProductsTableProps {
  storeId: string;
  products: Product[];
  loading: boolean;
  hasActiveFilters: boolean;
  onRequestDelete: (product: Product) => void;
}

export function ProductsTable({
  storeId,
  products,
  loading,
  hasActiveFilters,
  onRequestDelete,
}: ProductsTableProps) {
  const t = useT('products.list');
  // Localize the product name + image alt to the active admin locale.
  // Arabic merchants used to see English labels they didn't write.
  const locale = useLocale();
  const isRtl = locale === 'ar';

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-lg force-skeleton" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 force-skeleton" />
                <div className="h-3 w-24 force-skeleton" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return <EmptyProductsState storeId={storeId} hasActiveFilters={hasActiveFilters} />;
  }

  function productThumb(product: Product) {
    const displayName =
      (isRtl ? product.nameAr || product.name : product.name || product.nameAr) ?? '';
    return (
      <div className="h-10 w-10 rounded-lg bg-muted overflow-hidden shrink-0">
        {product.images?.[0] ? (
          <Image
            src={product.images[0].url}
            alt={displayName}
            width={40}
            height={40}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-muted-foreground">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
        )}
      </div>
    );
  }

  const columns: DataTableColumn<Product>[] = [
    {
      header: t('table.product'),
      primaryOnMobile: true,
      cell: product => {
        const displayName =
          (isRtl ? product.nameAr || product.name : product.name || product.nameAr) ?? '';
        return (
          <div className="flex items-center gap-3">
            {productThumb(product)}
            <div className="min-w-0">
              <p className="font-medium text-foreground truncate">{displayName}</p>
              {product.hasVariants && (
                <span className="text-xs text-info">{t('table.hasVariants')}</span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      header: t('table.sku'),
      cell: product => (
        <span className="text-sm text-muted-foreground font-mono">{product.sku || '-'}</span>
      ),
    },
    {
      header: t('table.price'),
      // For variant products the listed price is the cheapest variant
      // (set by scripts/backfill-variant-parent-prices.mjs). Surface
      // a "from" prefix so the merchant doesn't read a single price
      // and assume that's THE price across every size — clicking
      // through to the product takes them to the per-variant table.
      cell: product => (
        <span className="text-sm font-medium">
          {product.hasVariants && (
            <span className="text-xs text-muted-foreground me-1">{isRtl ? 'من' : 'From'}</span>
          )}
          {formatPrice(product.price)}
        </span>
      ),
    },
    {
      header: t('table.profit'),
      cell: product => {
        if (product.costPrice == null) {
          return (
            <span className="text-muted-foreground/70" title={t('table.profitHint')}>
              —
            </span>
          );
        }
        const margin = product.price - product.costPrice;
        const profitable = margin > 0;
        return (
          <span
            className={`font-medium ${
              profitable ? 'text-[hsl(var(--success))]' : 'text-destructive'
            }`}
          >
            {formatPrice(margin)}
          </span>
        );
      },
    },
    {
      header: t('table.inventory'),
      cell: product => (
        <span
          className={`text-sm font-medium ${
            product.inventory === 0
              ? 'text-destructive'
              : product.inventory < 10
                ? 'text-warning'
                : 'text-[hsl(var(--success))]'
          }`}
        >
          {product.inventory}
        </span>
      ),
    },
    {
      header: t('table.status'),
      cell: product => <StatusBadge status={product.status} />,
    },
    {
      header: t('table.actions'),
      alignEnd: true,
      cell: product => (
        <div className="flex items-center justify-end gap-2 flex-wrap">
          {product.hasVariants && (
            <Link href={`/stores/${storeId}/products/${product.id}/variants`}>
              <Button variant="outline" size="sm">
                {t('actions.variants')}
              </Button>
            </Link>
          )}
          <Link href={`/stores/${storeId}/products/${product.id}/edit`}>
            <Button variant="outline" size="sm">
              {t('actions.edit')}
            </Button>
          </Link>
          <Link href={`/stores/${storeId}/products/${product.id}`}>
            <Button variant="outline" size="sm">
              {t('actions.view')}
            </Button>
          </Link>
          <Button variant="destructive" size="sm" onClick={() => onRequestDelete(product)}>
            {t('actions.delete')}
          </Button>
        </div>
      ),
    },
  ];

  return <DataTable<Product> columns={columns} rows={products} rowKey={p => p.id} />;
}
