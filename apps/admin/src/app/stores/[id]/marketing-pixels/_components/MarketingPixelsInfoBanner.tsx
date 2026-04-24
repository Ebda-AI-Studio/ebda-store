'use client';

import { useT } from '@/i18n/useT';

/**
 * Top-of-page info banner that explains what marketing pixels are. Kept as its
 * own component so the page stays declarative.
 */
export function MarketingPixelsInfoBanner() {
  const t = useT('marketingPixels.info');

  return (
    <div className="bg-info/5 border border-info/30 rounded-lg p-4">
      <div className="flex items-start gap-3">
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
        <div className="text-sm text-info">
          <p className="font-medium mb-1">{t('title')}</p>
          <p>{t('body')}</p>
        </div>
      </div>
    </div>
  );
}
