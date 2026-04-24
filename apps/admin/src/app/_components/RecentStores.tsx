'use client';

import Link from 'next/link';
import { Badge, Button } from '@force/ui';
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
    <div className="force-card animate-slide-up p-0" style={{ animationDelay: '0.2s' }}>
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="font-semibold text-foreground">{t('recentStoresTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('recentStoresSubtitle')}</p>
        </div>
        <Link
          href="/stores"
          className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {t('viewAll')}
        </Link>
      </div>
      <div className="divide-y divide-border/50">
        {isLoading ? (
          <div className="space-y-4 p-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-xl force-skeleton" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 force-skeleton" />
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
              className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/30 cursor-pointer"
            >
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 font-bold text-primary">
                  {store.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="font-medium text-foreground">{store.name}</p>
                  <p className="text-sm text-muted-foreground">{store.owner?.email}</p>
                </div>
              </div>
              <div className="text-end">
                <Badge
                  variant={store.status === 'active' ? 'default' : 'secondary'}
                  className="capitalize"
                >
                  {store.status}
                </Badge>
                <p className="mt-1 text-xs text-muted-foreground">{formatDate(store.createdAt)}</p>
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
