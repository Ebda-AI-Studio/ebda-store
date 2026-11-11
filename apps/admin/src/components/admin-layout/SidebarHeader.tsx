'use client';

import { buttonVariants } from '@/components/ui/Button';
import Image from 'next/image';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import type { StoreBranding } from './buildStoreAdminNav';

interface SidebarHeaderProps {
  mode: 'super_admin' | 'store_admin';
  storeBranding?: StoreBranding;
  isStoreAdminWithBranding: boolean;
  /** Authenticated user role — distinct from `mode`. A super_admin viewing a
   *  store renders mode='store_admin' chrome but should still surface their
   *  actual role + a way back to the platform store list. */
  userRole?: 'super_admin' | 'store_admin' | 'staff' | 'customer';
}

export function SidebarHeader({
  mode,
  storeBranding,
  isStoreAdminWithBranding,
  userRole,
}: SidebarHeaderProps) {
  const t = useT('components.adminLayout');
  const tb = useT('components.brand');

  // True when the platform admin is browsing a specific store. We swap the
  // blue "Store Admin / Managing your store" badge for an indigo
  // "Super Admin / Viewing this store" badge + a "← All stores" link so
  // the super_admin always has a one-click escape back to the platform.
  const isSuperAdminViewingStore = userRole === 'super_admin' && mode === 'store_admin';
  const isStaffUser = userRole === 'staff';

  return (
    <>
      {/* Logo Section */}
      <div className="flex h-16 items-center gap-3 border-b border-border/50 px-6">
        {isStoreAdminWithBranding && storeBranding?.logo ? (
          // Store Branding Logo
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl overflow-hidden bg-muted shadow-lg">
              <Image
                src={storeBranding.logo}
                alt={storeBranding.name}
                width={36}
                height={36}
                className="h-9 w-9 object-contain"
              />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-lg font-bold text-foreground truncate block">
                {storeBranding.name}
              </span>
              {storeBranding.nameAr && (
                <span className="text-xs text-muted-foreground truncate block" dir="rtl">
                  {storeBranding.nameAr}
                </span>
              )}
            </div>
          </>
        ) : (
          // Ebda Branding (default)
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/90 shadow-lg shadow-primary/25">
              <Image
                src="/logo-white.svg"
                alt={tb('brandAlt')}
                width={12}
                height={22}
                unoptimized
              />
            </div>
            <div>
              <span className="text-lg font-bold">
                <span className="text-primary-ink">{tb('brandAlt')}</span>
                {mode === 'super_admin' && (
                  <span className="text-foreground"> {t('forcePlatformBrand')}</span>
                )}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Super Admin Badge */}
      {mode === 'super_admin' && (
        <div className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-primary/10 to-primary/10 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/90 text-xs font-bold text-primary-foreground shadow-sm">
              {/* i18n-gate-allow: role monogram */}
              SA
            </div>
            <div>
              <span className="text-xs font-semibold text-foreground">{t('superAdmin')}</span>
              <p className="text-xs text-muted-foreground">{t('superAdminHint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Staff Badge */}
      {isStaffUser && isStoreAdminWithBranding && (
        <div className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-primary/10 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground shadow-sm">
              {/* i18n-gate-allow: role monogram */}
              ST
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-foreground">{t('staffBadge')}</span>
              <p className="text-xs text-muted-foreground truncate">{t('staffBadgeHint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Store Admin Badge — actual store_admin role only */}
      {isStoreAdminWithBranding && !isSuperAdminViewingStore && !isStaffUser && (
        <div className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-blue-500/10 to-indigo-500/10 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow-sm">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-foreground">{t('storeAdmin')}</span>
              <p className="text-xs text-muted-foreground truncate">{t('storeAdminHint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Super Admin viewing a store — distinct badge + escape link */}
      {isSuperAdminViewingStore && (
        <div className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-primary/10 to-primary/10 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/90 text-xs font-bold text-primary-foreground shadow-sm">
              {/* i18n-gate-allow: role monogram */}
              SA
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-foreground">
                {t('superAdminViewingStore')}
              </span>
              <p className="text-xs text-muted-foreground truncate">
                {t('superAdminViewingStoreHint')}
              </p>
            </div>
          </div>
          <Link
            href="/stores"
            className={buttonVariants({
              variant: 'outline',
              size: 'sm',
              className: 'mt-2 justify-center gap-1.5',
            })}
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            {t('backToAllStores')}
          </Link>
        </div>
      )}
    </>
  );
}
