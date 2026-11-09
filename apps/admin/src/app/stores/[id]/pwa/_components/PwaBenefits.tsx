'use client';

import { useT } from '@/i18n/useT';

/**
 * Static informational section highlighting the three main PWA benefits.
 */
export function PwaBenefits() {
  const t = useT('pwa.benefits');

  return (
    <div className="bg-gradient-to-r from-primary/5 to-warning/10 border border-primary/30 rounded-xl p-6">
      <h3 className="font-semibold text-foreground mb-3">{t('title')}</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg
              className="w-4 h-4 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('install.title')}</p>
            <p className="text-sm text-muted-foreground">{t('install.description')}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg
              className="w-4 h-4 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('offline.title')}</p>
            <p className="text-sm text-muted-foreground">{t('offline.description')}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg
              className="w-4 h-4 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('fast.title')}</p>
            <p className="text-sm text-muted-foreground">{t('fast.description')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
