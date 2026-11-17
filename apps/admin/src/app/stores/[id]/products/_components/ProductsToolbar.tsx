'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/Button';
import { RowActions } from '@/components/RowActions';
import { useT } from '@/i18n/useT';

interface ProductsToolbarProps {
  storeId: string;
  /** Current products-list URL (path + filters/search/page), used as the
   *  `returnTo` target so creating a product lands back on this exact view. */
  listUrl: string;
}

/**
 * Placement standard rules 1-3: one primary ("Add product"), one visible secondary ("Import & export", so CSV/XLSX/photo
 * import and export are one tap from the list) and a "..." menu for the rest. No "back to store" (the
 * hub tab strip is the way back).
 */
export function ProductsToolbar({ storeId, listUrl }: ProductsToolbarProps) {
  const t = useT('products.list.toolbar');
  return (
    <div className="flex items-center gap-2">
      <RowActions
        menuLabel={t('more')}
        items={[
          { href: `/stores/${storeId}/products/new-arrivals/order`, label: t('orderNewArrivals') },
          { href: `/stores/${storeId}/products/best-sellers/order`, label: t('orderBestSellers') },
        ]}
      />
      <Link href={`/stores/${storeId}/bulk`} className={buttonVariants({ variant: 'outline' })}>
        {t('importExport')}
      </Link>
      <Link
        href={`/stores/${storeId}/products/new?returnTo=${encodeURIComponent(listUrl)}`}
        className={buttonVariants()}
      >
        {t('addProduct')}
      </Link>
    </div>
  );
}
