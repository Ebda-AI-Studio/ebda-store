'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ReactNode } from 'react';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';

interface MinimalChromeProps {
  children: ReactNode;
  /**
   * Optional short label shown next to the logo — used by /checkout for a
   * "Secure Checkout" chip. Auth pages typically leave this empty.
   */
  label?: string;
  labelAr?: string;
  /** Show a lock icon next to the label. Default true if label is provided. */
  showLockIcon?: boolean;
}

/**
 * Minimal storefront chrome: logo + optional label. No nav, no footer.
 * Used on auth, checkout, and public-share pages where nav would distract
 * from the task. Colors, fonts, and logo come from the store's theme; no
 * hardcoded branding.
 */
export function MinimalChrome({
  children,
  label,
  labelAr,
  showLockIcon = !!label,
}: MinimalChromeProps) {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { language } = useLanguage();
  const isRtl = language === 'ar';
  const displayLabel = isRtl ? (labelAr ?? label) : (label ?? labelAr);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header role="banner">
        <nav
          className="border-b bg-background"
          aria-label={displayLabel || (isRtl ? 'التنقل' : 'Navigation')}
        >
          <div className="mx-auto flex h-28 max-w-7xl items-center justify-between px-4 sm:h-32 sm:px-6 lg:px-8">
            <Link href={storeUrl('/')} className="flex items-center gap-2">
              {store.logo ? (
                <Image
                  src={store.logo}
                  alt={store.name}
                  width={320}
                  height={120}
                  priority
                  className="h-20 w-auto max-w-[320px] object-contain sm:h-24 sm:max-w-[360px]"
                />
              ) : (
                <span className="text-2xl font-bold text-primary sm:text-3xl">{store.name}</span>
              )}
            </Link>
            {displayLabel && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {showLockIcon && (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    />
                  </svg>
                )}
                <span>{displayLabel}</span>
              </div>
            )}
          </div>
        </nav>
      </header>
      <main role="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
