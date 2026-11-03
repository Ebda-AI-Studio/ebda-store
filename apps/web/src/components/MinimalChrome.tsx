'use client';

import Link from './StoreLink';
import { ReactNode } from 'react';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { StoreLogo } from '../templates/shared/StoreLogo';
import { pickLocalizedName } from '../templates/shared/display-helpers';
import { wordmarkClass } from '../templates/shared/wordmark';

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
  const storeName = pickLocalizedName(store, isRtl) ?? '';
  // PREMIUM-11: the logo follows the language like the header does (Arabic logo in an Arabic store).
  const logo = isRtl && store.logoAr ? store.logoAr : store.logo;
  const displayLabel = isRtl ? (labelAr ?? label) : (label ?? labelAr);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header role="banner">
        <nav
          className="border-b bg-background"
          aria-label={displayLabel || (isRtl ? 'التنقل' : 'Navigation')}
        >
          <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 md:h-24 md:px-6 lg:px-8">
            <Link href={storeUrl('/')} className="flex min-h-11 min-w-11 items-center gap-2">
              {logo ? (
                // Adaptive StoreLogo (same component as the 5 theme headers) so
                // checkout / auth / share pages honor the store's `theme.logoSize`
                // and aspect-fit exactly like the storefront header — not a
                // separate hardcoded bounding box.
                <StoreLogo src={logo} alt={storeName} priority />
              ) : (
                // A look that sizes its wordmark (W2a T-01) shows the SAME wordmark here as in the
                // storefront header; every other store keeps this bold primary name.
                <span
                  className={
                    store.theme?.wordmarkSize
                      ? wordmarkClass(store.theme.wordmarkSize)
                      : 'text-2xl font-bold text-primary sm:text-3xl'
                  }
                  data-zone={store.theme?.wordmarkSize ? 'storeName' : undefined}
                  translate="no"
                >
                  {storeName}
                </span>
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
