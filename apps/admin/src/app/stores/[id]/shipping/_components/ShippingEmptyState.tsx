'use client';

import { useT } from '@/i18n/useT';

interface ShippingEmptyStateProps {
  onCreate: () => void;
}

export function ShippingEmptyState({ onCreate }: ShippingEmptyStateProps) {
  const t = useT('shipping.empty');

  return (
    <div className="bg-card rounded-xl border border-border p-12 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
        <svg
          className="w-8 h-8 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{t('title')}</h3>
      <p className="text-muted-foreground mb-6">{t('description')}</p>
      <button
        type="button"
        onClick={onCreate}
        className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
      >
        {t('createFirst')}
      </button>
    </div>
  );
}
