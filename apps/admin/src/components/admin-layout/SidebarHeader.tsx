'use client';

import Image from 'next/image';
import { useT } from '@/i18n/useT';
import type { StoreBranding } from './buildStoreAdminNav';

interface SidebarHeaderProps {
  mode: 'super_admin' | 'store_admin';
  storeBranding?: StoreBranding;
  isStoreAdminWithBranding: boolean;
}

export function SidebarHeader({
  mode,
  storeBranding,
  isStoreAdminWithBranding,
}: SidebarHeaderProps) {
  const t = useT('components.adminLayout');
  const tb = useT('components.brand');

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
              <span className="text-lg font-bold tracking-tight text-foreground truncate block">
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
          // Force Media Branding (default)
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/90 shadow-lg shadow-primary/25">
              <Image
                src="/logo.svg"
                alt={tb('forceMediaAlt')}
                width={20}
                height={15}
                className="brightness-0 invert"
                unoptimized
              />
            </div>
            <div>
              <span className="text-lg font-bold tracking-tight">
                <span className="text-primary">{t('forceBrandPrefix')}</span>
                <span className="text-foreground">
                  {' '}
                  {mode === 'super_admin' ? t('forcePlatformBrand') : t('forceAdminBrand')}
                </span>
              </span>
            </div>
          </>
        )}
      </div>

      {/* Super Admin Badge */}
      {mode === 'super_admin' && (
        <div className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-primary/10 to-primary/10 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/90 text-[10px] font-bold text-white shadow-sm">
              SA
            </div>
            <div>
              <span className="text-xs font-semibold text-foreground">{t('superAdmin')}</span>
              <p className="text-[10px] text-muted-foreground">{t('superAdminHint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Store Admin Badge */}
      {isStoreAdminWithBranding && (
        <div className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-blue-500/10 to-indigo-500/10 px-3 py-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-[10px] font-bold text-white shadow-sm">
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
              <p className="text-[10px] text-muted-foreground truncate">{t('storeAdminHint')}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
