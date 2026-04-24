'use client';

import Link from 'next/link';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { formatDate, planConfig, statusConfig, type Store } from './types';

interface StoresTableProps {
  stores: Store[];
}

export function StoresTable({ stores }: StoresTableProps) {
  const t = useT('stores.list');

  return (
    <div className="force-card p-0 overflow-hidden overflow-x-auto">
      <table className="w-full" aria-label={t('tableLabel')}>
        <thead className="bg-muted/50 border-b">
          <tr>
            <th
              scope="col"
              className="px-6 py-4 text-start text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colStore')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-start text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colOwner')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-start text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colStatus')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-start text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colPlan')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colProducts')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colOrders')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-start text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colCreated')}
            </th>
            <th
              scope="col"
              className="px-6 py-4 text-end text-xs font-semibold text-muted-foreground uppercase tracking-wider"
            >
              {t('colActions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {stores.map(store => {
            const status = statusConfig[store.status];
            const plan = planConfig[store.plan];
            return (
              <tr key={store.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 font-bold text-primary">
                      {store.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{store.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {store.domain || `${store.slug}.forcemediakw.com`}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {store.owner.firstName} {store.owner.lastName}
                    </p>
                    <p className="text-sm text-muted-foreground">{store.owner.email}</p>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.bg} ${status.text}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                    {t(`status.${store.status}`)}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium ${plan.bg} ${plan.text}`}
                  >
                    <span>{plan.icon}</span>
                    <span className="capitalize">{store.plan}</span>
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className="font-semibold text-foreground">
                    {store._count?.products || 0}
                  </span>
                </td>
                <td className="px-6 py-4 text-center">
                  <span className="font-semibold text-foreground">{store._count?.orders || 0}</span>
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {formatDate(store.createdAt)}
                </td>
                <td className="px-6 py-4 text-end">
                  <Link href={`/stores/${store.id}`}>
                    <Button variant="outline" size="sm" className="rounded-xl">
                      {t('view')}
                    </Button>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
