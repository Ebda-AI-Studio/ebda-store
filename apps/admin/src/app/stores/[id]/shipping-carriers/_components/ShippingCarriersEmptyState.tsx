'use client';

import { useT } from '@/i18n/useT';

/**
 * Rendered when the `shipping_carriers` feature is disabled for the store.
 * Prompts the admin to enable it in store features.
 */
export function ShippingCarriersEmptyState() {
  const t = useT('shipping.carriers.empty');

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 bg-info/10 rounded-full flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-info-ink"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
          />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">{t('title')}</h2>
      <p className="text-muted-foreground max-w-md">{t('description')}</p>
    </div>
  );
}
