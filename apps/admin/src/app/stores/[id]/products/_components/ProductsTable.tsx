'use client';

import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@force/ui';
import { formatPrice } from '../../../../../lib/format';
import { useT } from '@/i18n/useT';
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

  return (
    <div className="rounded-xl border bg-card overflow-hidden overflow-x-auto">
      <table className="w-full" aria-label={t('table.label')}>
        <thead className="bg-muted border-b">
          <tr>
            <th
              scope="col"
              className="px-4 py-3 text-start text-sm font-medium text-muted-foreground"
            >
              {t('table.product')}
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-start text-sm font-medium text-muted-foreground"
            >
              {t('table.sku')}
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-start text-sm font-medium text-muted-foreground"
            >
              {t('table.price')}
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-start text-sm font-medium text-muted-foreground"
            >
              {t('table.inventory')}
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-start text-sm font-medium text-muted-foreground"
            >
              {t('table.status')}
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-end text-sm font-medium text-muted-foreground"
            >
              {t('table.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg force-skeleton" />
                    <div className="h-4 w-36 force-skeleton" />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="h-4 w-20 force-skeleton" />
                </td>
                <td className="px-4 py-3">
                  <div className="h-4 w-16 force-skeleton" />
                </td>
                <td className="px-4 py-3">
                  <div className="h-4 w-10 force-skeleton" />
                </td>
                <td className="px-4 py-3">
                  <div className="h-6 w-16 rounded-full force-skeleton" />
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <div className="h-8 w-14 rounded-lg force-skeleton" />
                    <div className="h-8 w-14 rounded-lg force-skeleton" />
                  </div>
                </td>
              </tr>
            ))
          ) : products.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-16 text-center">
                <EmptyProductsState storeId={storeId} hasActiveFilters={hasActiveFilters} />
              </td>
            </tr>
          ) : (
            products.map(product => (
              <tr
                key={product.id}
                className="hover:bg-muted/50 transition-colors duration-150 cursor-pointer"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-muted overflow-hidden">
                      {product.images?.[0] ? (
                        <Image
                          src={product.images[0].url}
                          alt={product.name}
                          width={40}
                          height={40}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-muted-foreground">
                          <svg
                            className="h-5 w-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
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
                    <div>
                      <p className="font-medium text-foreground">{product.name}</p>
                      {product.hasVariants && (
                        <span className="text-xs text-info">{t('table.hasVariants')}</span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground font-mono">
                  {product.sku || '-'}
                </td>
                <td className="px-4 py-3 text-sm font-medium">{formatPrice(product.price)}</td>
                <td className="px-4 py-3">
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
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={product.status} />
                </td>
                <td className="px-4 py-3 text-end">
                  <div className="flex items-center justify-end gap-2">
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
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => onRequestDelete(product)}
                    >
                      {t('actions.delete')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
