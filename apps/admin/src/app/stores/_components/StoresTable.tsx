'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { getStoreDisplayUrl } from '@/lib/store-url';
import { RowActions } from '@/components/RowActions';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { StoreAvatar } from './StoreAvatar';
import { formatDate, statusConfig, type Store } from './types';

interface StoresTableProps {
  stores: Store[];
  /** Present only for super_admin: adds "Delete store" as the last item of the row menu. */
  onDelete?: (store: Store) => void;
}

export function StoresTable({ stores, onDelete }: StoresTableProps) {
  const t = useT('stores.list');

  const columns: DataTableColumn<Store>[] = [
    {
      header: t('colStore'),
      primaryOnMobile: true,
      cell: store => (
        <div className="flex items-center gap-3">
          <StoreAvatar name={store.name} logo={store.logo} className="h-10 w-10 shrink-0" />

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
        <RowActions
          menuLabel={t('rowMenuLabel', { name: store.name })}
          primary={
            <Link href={`/stores/${store.id}`}>
              <Button variant="outline" size="sm">
                {t('view')}
              </Button>
            </Link>
          }
          items={
            onDelete
              ? [{ label: t('deleteStore'), destructive: true, onSelect: () => onDelete(store) }]
              : []
          }
        />
      ),
    },
  ];

  return (
    <DataTable<Store>
      ariaLabel={t('tableLabel')}
      columns={columns}
      rows={stores}
      rowKey={s => s.id}
    />
  );
}
