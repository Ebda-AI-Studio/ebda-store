'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import type { ProductSummary } from './ProductSearch';

import { Button } from '@/components/ui/Button';
interface SelectedProductCardProps {
  product: ProductSummary;
  onRemove: () => void;
}

export function SelectedProductCard({ product, onRemove }: SelectedProductCardProps) {
  const t = useT('products.recommendations');
  const locale = useLocale();
  const isRtl = locale === 'ar';
  const displayName = isRtl
    ? product.nameAr || product.name
    : product.name || product.nameAr || product.name;

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <div className="h-10 w-10 rounded-md bg-muted overflow-hidden flex-shrink-0">
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
      <span className="flex-1 text-sm font-medium text-foreground truncate">{displayName}</span>
      <Button
        type="button"
        onClick={onRemove}
        aria-label={t('removeAria', { name: displayName })}
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </Button>
    </div>
  );
}
