'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import type { Store } from './types';

interface QuickActionsProps {
  store: Store;
  isSuperAdmin: boolean;
  isChangingStatus: boolean;
  onRequestSuspend: () => void;
  onActivate: () => void;
}

export function QuickActions({
  store,
  isSuperAdmin,
  isChangingStatus,
  onRequestSuspend,
  onActivate,
}: QuickActionsProps) {
  const t = useT('stores.dashboard.quickActions');

  return (
    <div className="mt-8">
      <h2 className="mb-4 font-semibold text-foreground">{t('title')}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {store.status === 'active' ? (
          <button
            disabled={isChangingStatus}
            onClick={onRequestSuspend}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all duration-200 hover:border-destructive/40 hover:shadow-md cursor-pointer text-start disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
              {isChangingStatus ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-destructive/40 border-t-red-600" />
              ) : (
                <svg
                  className="h-5 w-5 text-destructive"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
              )}
            </div>
            <div>
              <p className="font-medium text-foreground">{t('suspend')}</p>
              <p className="text-xs text-muted-foreground">{t('suspendDescription')}</p>
            </div>
          </button>
        ) : (
          <button
            disabled={isChangingStatus}
            onClick={onActivate}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all duration-200 hover:border-success/40 hover:shadow-md cursor-pointer text-start disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
              {isChangingStatus ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-success/40 border-t-green-600" />
              ) : (
                <svg
                  className="h-5 w-5 text-success"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              )}
            </div>
            <div>
              <p className="font-medium text-foreground">{t('activate')}</p>
              <p className="text-xs text-muted-foreground">{t('activateDescription')}</p>
            </div>
          </button>
        )}

        <Link
          href={`/stores/${store.id}/products`}
          className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary hover:shadow-md cursor-pointer"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info/10">
            <svg
              className="h-5 w-5 text-info"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('viewProducts')}</p>
            <p className="text-xs text-muted-foreground">
              {t('viewProductsCount', { count: store._count?.products || 0 })}
            </p>
          </div>
        </Link>

        <Link
          href={`/stores/${store.id}/orders`}
          className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary hover:shadow-md cursor-pointer"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info/10">
            <svg
              className="h-5 w-5 text-info"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('viewOrders')}</p>
            <p className="text-xs text-muted-foreground">
              {t('viewOrdersCount', { count: store._count?.orders || 0 })}
            </p>
          </div>
        </Link>

        <Link
          href={`/stores/${store.id}/analytics`}
          className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary hover:shadow-md cursor-pointer"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
            <svg
              className="h-5 w-5 text-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('analytics')}</p>
            <p className="text-xs text-muted-foreground">{t('analyticsDescription')}</p>
          </div>
        </Link>

        {isSuperAdmin && (
          <Link
            href={`/stores/${store.id}/features`}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary hover:shadow-md cursor-pointer"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info/10">
              <svg
                className="h-5 w-5 text-info"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 10h16M4 14h16M4 18h16"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground">{t('manageFeatures')}</p>
              <p className="text-xs text-muted-foreground">{t('manageFeaturesDescription')}</p>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}
