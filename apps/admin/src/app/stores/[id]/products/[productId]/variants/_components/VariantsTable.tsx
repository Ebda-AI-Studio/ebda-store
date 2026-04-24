'use client';

import { Badge } from '@force/ui';
import { useT } from '@/i18n/useT';
import { formatPrice } from '../../../../../../../lib/format';
import type { Variant } from './types';

interface VariantsTableProps {
  variants: Variant[];
  onEdit: (variant: Variant) => void;
  onDelete: (variantId: string) => void;
}

export function VariantsTable({ variants, onEdit, onDelete }: VariantsTableProps) {
  const t = useT('products.variants.table');

  return (
    <div className="lg:col-span-2 rounded-xl border bg-card shadow-sm">
      <div className="border-b p-4">
        <h3 className="font-semibold text-foreground">
          {t('variants', { count: variants.length })}
        </h3>
      </div>

      {variants.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground">
          <svg
            className="mx-auto h-12 w-12 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
          <p className="mt-2 text-sm">{t('empty')}</p>
          <p className="text-xs">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t('label')}>
            <thead className="bg-muted text-start text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3">
                  {t('variant')}
                </th>
                <th scope="col" className="px-4 py-3">
                  {t('sku')}
                </th>
                <th scope="col" className="px-4 py-3 text-end">
                  {t('price')}
                </th>
                <th scope="col" className="px-4 py-3 text-end">
                  {t('stock')}
                </th>
                <th scope="col" className="px-4 py-3 text-center">
                  {t('status')}
                </th>
                <th scope="col" className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {variants.map(variant => (
                <tr key={variant.id} className="hover:bg-muted">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{variant.title}</p>
                    {variant.titleAr && (
                      <p className="text-xs text-muted-foreground" dir="rtl">
                        {variant.titleAr}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{variant.sku || t('dash')}</td>
                  <td className="px-4 py-3 text-end">
                    {variant.price ? (
                      formatPrice(variant.price)
                    ) : (
                      <span className="text-muted-foreground">{t('base')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <span className={variant.inventory <= 0 ? 'text-destructive' : ''}>
                      {variant.inventory}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant={variant.isActive ? 'default' : 'secondary'}>
                      {variant.isActive ? t('active') : t('inactive')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => onEdit(variant)}
                        className="text-muted-foreground hover:text-primary"
                        title={t('edit')}
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(variant.id)}
                        className="text-muted-foreground hover:text-destructive"
                        title={t('delete')}
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
