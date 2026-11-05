'use client';

import type { ProductGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import DahabProductCard from './ProductCard';
import { fitDesktopColumns } from '../shared/grid-helpers';
import { DAHAB_CONTAINER, DahabSectionHeading, cx, pick } from './ui';

/** Grid density → column classes (2 on phones, 3 on tablets, N on desktop). */
export function dahabGridCols(columns: number, mobileColumns = 2): string {
  const desktop =
    columns >= 5
      ? 'lg:grid-cols-5'
      : columns === 4
        ? 'lg:grid-cols-4'
        : columns === 3
          ? 'lg:grid-cols-3'
          : 'lg:grid-cols-2';
  return cx(
    'grid gap-x-3 gap-y-8 sm:gap-x-5 sm:gap-y-10',
    mobileColumns === 1 ? 'grid-cols-1' : 'grid-cols-2',
    columns >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
    desktop
  );
}

export default function DahabProductGrid({
  products,
  isRtl: isRtlProp,
  title,
  titleAr,
  columns = 4,
  onAddToCart,
  urlPrefix = '',
}: ProductGridProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  return (
    <div className={DAHAB_CONTAINER} data-zone="products">
      <DahabSectionHeading title={pick(isRtl, title, titleAr)} />
      {products.length > 0 ? (
        <div
          data-part="product-grid"
          className={dahabGridCols(fitDesktopColumns(products.length, columns))}
        >
          {products.map(product => (
            <DahabProductCard
              key={product.id}
              product={product}
              isRtl={isRtl}
              onAddToCart={onAddToCart}
              urlPrefix={urlPrefix}
            />
          ))}
        </div>
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t('No pieces to show yet.', 'مفيش قطع للعرض دلوقتي.')}
        </p>
      )}
    </div>
  );
}
