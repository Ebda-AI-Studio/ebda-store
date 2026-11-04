'use client';

import Link from 'next/link';
import { Badge, Button } from '@ebda/ui';
import { formatDate } from '../../lib/format';
import { useT } from '@/i18n/useT';
import type { RecentStore } from './types';

interface RecentStoresProps {
  stores: RecentStore[];
  isLoading: boolean;
}

export function RecentStores({ stores, isLoading }: RecentStoresProps) {
  const t = useT('dashboard.super');

  return (
    // Slim variant matching RecentOrders — half the vertical
    // padding, smaller initials tile, status pill inline next to
    // the date instead of stacked.
    <div className="force-card animate-slide-up p-0" style={{ animationDelay: '0.2s' }}>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('recentStoresTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('recentStoresSubtitle')}</p>
        </div>
        <Link
          href="/stores"
          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {t('viewAll')}
        </Link>
      </div>
      <div className="divide-y divide-border/50">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg force-skeleton" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-32 force-skeleton" />
                  <div className="h-3 w-48 force-skeleton" />
                </div>
              </div>
            ))}
          </div>
        ) : stores.length > 0 ? (
          stores.map(store => (
            <Link
              key={store.id}
              href={`/stores/${store.id}`}
              className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30 cursor-pointer"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary-ink">
                  {store.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{store.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{store.owner?.email}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge
                  variant={store.status === 'active' ? 'default' : 'secondary'}
                  className="text-xs px-2 py-0.5 capitalize"
                >
                  {store.status}
                </Badge>
                <p className="text-xs text-muted-foreground">{formatDate(store.createdAt)}</p>
              </div>
            </Link>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <svg
                className="h-8 w-8 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
            </div>
            <p className="font-medium text-foreground">{t('noStoresTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('noStoresSubtitle')}</p>
            <Link href="/stores/new" className="mt-4">
              <Button size="sm" variant="outline">
                {t('createStore')}
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
