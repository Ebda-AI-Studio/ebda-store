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
      <Link href={`/stores/${storeId}`}>
        <Button variant="outline" size="sm">
          {t('backToStore')}
        </Button>
      </Link>
    </div>
  );
}
