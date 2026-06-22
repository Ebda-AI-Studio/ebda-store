'use client';

import Link from 'next/link';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';

interface ProductsToolbarProps {
  storeId: string;
}

export function ProductsToolbar({ storeId }: ProductsToolbarProps) {
  const t = useT('products.list.toolbar');

  return (
    <div className="flex gap-2">
      <Link href={`/stores/${storeId}/products/new`}>
        <Button size="sm">
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('addProduct')}
        </Button>
      </Link>
      <Link href={`/stores/${storeId}/bulk`}>
        <Button variant="outline" size="sm">
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
            />
          </svg>
          {t('bulkImport')}
        </Button>
      </Link>
      <Link href={`/stores/${storeId}/products/new-arrivals/order`}>
        <Button variant="outline" size="sm">
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h7"
            />
          </svg>
          {t('orderNewArrivals')}
        </Button>
      </Link>
      <Link href={`/stores/${storeId}/products/best-sellers/order`}>
        <Button variant="outline" size="sm">
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969
                 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755
                 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197
                 -1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81
                 .588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
          {t('orderBestSellers')}
        </Button>
      </Link>
      <Link href={`/stores/${storeId}`}>
        <Button variant="outline" size="sm">
          {t('backToStore')}
        </Button>
      </Link>
    </div>
  );
}
