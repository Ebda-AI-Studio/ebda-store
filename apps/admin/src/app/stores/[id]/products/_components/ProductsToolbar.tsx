'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';

interface ProductsToolbarProps {
  storeId: string;
  /** Current products-list URL (path + filters/search/page), used as the
   *  `returnTo` target so creating a product lands back on this exact view. */
  listUrl: string;
}

/**
 * One primary action ("Add product") and a "More" menu for the rest. Four outline buttons in the header bar
 * overflowed the page at 1280px and clipped "Back to store" (audit P-1).
 */
export function ProductsToolbar({ storeId, listUrl }: ProductsToolbarProps) {
  const t = useT('products.list.toolbar');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = [
    { href: `/stores/${storeId}/bulk`, label: t('bulkImport') },
    { href: `/stores/${storeId}/products/new-arrivals/order`, label: t('orderNewArrivals') },
    { href: `/stores/${storeId}/products/best-sellers/order`, label: t('orderBestSellers') },
    { href: `/stores/${storeId}`, label: t('backToStore') },
  ];

  return (
    <div className="flex items-center gap-2">
      <Link href={`/stores/${storeId}/products/new?returnTo=${encodeURIComponent(listUrl)}`}>
        <Button size="sm">
          <svg
            className="me-2 h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('addProduct')}
        </Button>
      </Link>
      <div className="relative" ref={rootRef}>
        <Button
          variant="outline"
          size="sm"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          {t('more')}
          <svg
            className="ms-1.5 h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </Button>
        {open && (
          <div
            role="menu"
            className="absolute end-0 z-30 mt-1 min-w-48 rounded-xl border border-border bg-card p-1 shadow-lg"
          >
            {items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {item.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
