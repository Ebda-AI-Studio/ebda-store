'use client';

import { useT } from '@/i18n/useT';
import { combinedActiveRate, type TaxRate } from './types';

interface TaxInfoBoxProps {
  taxEnabled: boolean;
  activeRates: Pick<TaxRate, 'rate' | 'isActive'>[];
}

/**
 * Bottom info panel: how the charge works (every active rate applies to every
 * order, summed — ruling TAX-1) and the combined rate it applies right now.
 * It used to explain priority and compound semantics the charge never had
 * (issue 2357).
 */
export function TaxInfoBox({ taxEnabled, activeRates }: TaxInfoBoxProps) {
  const t = useT('tax.info');

  return (
    <div className="mt-6 bg-info/5 border border-info/30 rounded-md p-4">
      <div className="flex gap-3">
        <svg
          className="w-5 h-5 text-info mt-0.5 shrink-0"
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
          <h3 className="text-sm font-medium text-info-ink">{t('title')}</h3>
          <p className="text-sm text-info-ink mt-1">{t('sum')}</p>
          <p className="text-sm font-medium text-info-ink mt-1" data-testid="tax-combined-rate">
            {taxEnabled ? t('combined', { rate: combinedActiveRate(activeRates) }) : t('off')}
          </p>
        </div>
      </div>
    </div>
  );
}
