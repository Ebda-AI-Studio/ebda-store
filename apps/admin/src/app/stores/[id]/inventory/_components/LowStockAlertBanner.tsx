'use client';

import { useT } from '@/i18n/useT';
import type { ProductInventory } from './types';

interface LowStockAlertBannerProps {
  alerts: ProductInventory[];
  onViewAlerts: () => void;
}

/**
 * Compact banner shown above tabs when any product needs attention.
 * The click handler usually switches the active tab to "alerts".
 */
export function LowStockAlertBanner({ alerts, onViewAlerts }: LowStockAlertBannerProps) {
  const t = useT('inventory.alertBanner');

  const outCount = alerts.filter(a => a.stockStatus === 'out_of_stock').length;
  const lowCount = alerts.filter(a => a.stockStatus === 'low_stock').length;

  return (
    <div className="bg-warning/5 border border-warning/30 rounded-xl p-4 mb-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-warning/10 rounded-full flex items-center justify-center">
          <svg
            className="w-5 h-5 text-warning"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <p className="font-medium text-warning">{t('needAttention', { count: alerts.length })}</p>
          <p className="text-sm text-warning">{t('breakdown', { out: outCount, low: lowCount })}</p>
        </div>
        <button
          onClick={onViewAlerts}
          className="px-4 py-2 bg-warning/10 text-warning dark:bg-warning/30 dark:text-warning rounded-lg hover:bg-warning/20 text-sm font-medium"
        >
          {t('viewAlerts')}
        </button>
      </div>
    </div>
  );
}
