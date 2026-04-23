'use client';

import { useT } from '@/i18n/useT';

/**
 * Bottom info panel summarising how priority and compound-vs-standard taxes work.
 */
export function TaxInfoBox() {
  const t = useT('tax.info');

  return (
    <div className="mt-6 bg-info/5 border border-info/30 rounded-xl p-4">
      <div className="flex gap-3">
        <svg
          className="w-5 h-5 text-info mt-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div>
          <h3 className="text-sm font-medium text-info">{t('title')}</h3>
          <p className="text-sm text-info mt-1">
            {t('priority')} <strong>{t('compoundLabel')}</strong> {t('compoundDescription')}{' '}
            <strong>{t('standardLabel')}</strong> {t('standardDescription')}
          </p>
        </div>
      </div>
    </div>
  );
}
