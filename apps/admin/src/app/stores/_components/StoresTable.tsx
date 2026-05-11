'use client';

import Link from 'next/link';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { getStoreDisplayUrl } from '@/lib/store-url';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { formatDate, planConfig, statusConfig, type Store } from './types';

interface StoresTableProps {
  stores: Store[];
}

export function StoresTable({ stores }: StoresTableProps) {
  const t = useT('stores.list');

  const columns: DataTableColumn<Store>[] = [
    {
      header: t('colStore'),
      primaryOnMobile: true,
      cell: store => (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 font-bold text-primary shrink-0">
            {store.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate">{store.name}</p>
            <p className="text-sm text-muted-foreground truncate">{getStoreDisplayUrl(store)}</p>
          </div>
        </div>
      ),
    },
    {
      header: t('colOwner'),
      cell: store => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {store.owner.firstName} {store.owner.lastName}
          </p>
          <p className="text-sm text-muted-foreground">{store.owner.email}</p>
        </div>
      ),
    },
    {
      header: t('colStatus'),
      mobileBadge: true,
      cell: store => {
        const status = statusConfig[store.status];
        return (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.bg} ${status.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {t(`status.${store.status}`)}
          </span>
        );
      },
    },
    {
      header: t('colPlan'),
      cell: store => {
        const plan = planConfig[store.plan];
        return (
          <span
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium ${plan.bg} ${plan.text}`}
          >
            <span>{plan.icon}</span>
            <span className="capitalize">{store.plan}</span>
          </span>
        );
      },
    },
    {
      header: t('colProducts'),
      cell: store => (
        <span className="font-semibold text-foreground">{store._count?.products || 0}</span>
      ),
    },
    {
      header: t('colOrders'),
      cell: store => (
        <span className="font-semibold text-foreground">{store._count?.orders || 0}</span>
      ),
    },
    {
      header: t('colCreated'),
      hideOnMobile: true,
      cell: store => (
        <span className="text-sm text-muted-foreground">{formatDate(store.createdAt)}</span>
      ),
    },
    {
      header: t('colActions'),
      alignEnd: true,
      mobileActions: true,
      cell: store => (
        <Link href={`/stores/${store.id}`}>
          <Button variant="outline" size="sm" className="rounded-xl">
            {t('view')}
          </Button>
        </Link>
      ),
    },
  ];

  return <DataTable<Store> columns={columns} rows={stores} rowKey={s => s.id} />;
}
