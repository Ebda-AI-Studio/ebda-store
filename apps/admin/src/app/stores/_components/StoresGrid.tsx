'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { formatDate, planConfig, statusConfig, type Store } from './types';

interface StoresGridProps {
  stores: Store[];
}

export function StoresGrid({ stores }: StoresGridProps) {
  const t = useT('stores.list');

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 stagger-animation">
      {stores.map((store, index) => {
        const status = statusConfig[store.status];
        const plan = planConfig[store.plan];
        return (
          <Link
            key={store.id}
            href={`/stores/${store.id}`}
            className="force-card group relative overflow-hidden"
            style={{ animationDelay: `${index * 0.05}s` }}
          >
            {/* Status Indicator */}
            <div className="absolute top-4 end-4">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.bg} ${status.text}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${status.dot} ${store.status === 'active' ? 'animate-pulse' : ''}`}
                />
                {t(`status.${store.status}`)}
              </span>
            </div>

            {/* Store Header */}
            <div className="flex items-start gap-4 mb-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-xl font-bold text-primary transition-transform group-hover:scale-110">
                {store.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 pt-1">
                <h3 className="font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                  {store.name}
                </h3>
                <p className="text-sm text-muted-foreground truncate">
                  {store.domain || `${store.slug}.forcemediakw.com`}
                </p>
              </div>
            </div>

            {/* Owner Info */}
            <div className="flex items-center gap-2 mb-4 pb-4 border-b border-border/50">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground">
                {store.owner.firstName?.[0]}
                {store.owner.lastName?.[0]}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {store.owner.firstName} {store.owner.lastName}
                </p>
                <p className="text-xs text-muted-foreground truncate">{store.owner.email}</p>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="text-center">
                <p className="text-lg font-bold text-foreground">{store._count?.products || 0}</p>
                <p className="text-xs text-muted-foreground">{t('products')}</p>
              </div>
              <div className="text-center border-x border-border/50">
                <p className="text-lg font-bold text-foreground">{store._count?.orders || 0}</p>
                <p className="text-xs text-muted-foreground">{t('orders')}</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-foreground">
                  <span
                    className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs ${plan.bg} ${plan.text}`}
                  >
                    <span>{plan.icon}</span>
                    <span className="capitalize">{store.plan}</span>
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{t('plan')}</p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-4 border-t border-border/50">
              <span className="text-xs text-muted-foreground">
                {t('createdPrefix', { date: formatDate(store.createdAt) })}
              </span>
              <span className="text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                {t('viewDetails')}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
