'use client';

import { useT } from '@/i18n/useT';
import { formatPrice } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { RowActions } from '@/components/RowActions';
import { useConfirm } from '@/hooks/useConfirm';
import type { Coupon } from './types';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';

interface CouponsTableProps {
  coupons: Coupon[];
  onEdit: (coupon: Coupon) => void;
  onDelete: (couponId: string) => void;
  onToggleActive: (couponId: string) => void;
  onCreateFirst: () => void;
}

interface CouponStatus {
  labelKey: 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'active';
  color: string;
}

function getCouponStatus(coupon: Coupon): CouponStatus {
  if (!coupon.isActive) {
    return { labelKey: 'inactive', color: 'bg-muted text-foreground' };
  }

  const now = new Date();
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    return {
      labelKey: 'scheduled',
      color: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
    };
  }
  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return {
      labelKey: 'expired',
      color:
        'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink',
    };
  }
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
    return {
      labelKey: 'exhausted',
      color: 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink',
    };
  }
  return {
    labelKey: 'active',
    color: 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink',
  };
}

/**
 * Coupons listing — desktop table, mobile cards. Uses the shared
 * `<DataTable>` so the responsive behaviour matches every other admin
 * list (orders, products, customers, etc.) and a phone-first merchant
 * sees a tappable card stack instead of a horizontally-scrolling table.
 */
export function CouponsTable({
  coupons,
  onEdit,
  onDelete,
  onToggleActive,
  onCreateFirst,
}: CouponsTableProps) {
  const tTable = useT('coupons.table');
  const tStatus = useT('coupons.status');
  const tType = useT('coupons.type');
  const tEmpty = useT('coupons.empty');
  const tActions = useT('coupons.actions');
  const askConfirm = useConfirm();

  function formatValue(coupon: Coupon): string {
    if (coupon.type === 'percentage') return `${coupon.value}%`;
    if (coupon.type === 'fixed') return formatPrice(coupon.value);
    return tType('freeShipping');
  }

  function typeLabel(coupon: Coupon): string {
    if (coupon.type === 'percentage') return tType('percentage');
    if (coupon.type === 'fixed') return tType('fixed');
    return tType('freeShipping');
  }

  const columns: DataTableColumn<Coupon>[] = [
    {
      header: tTable('code'),
      primaryOnMobile: true,
      cell: coupon => (
        <span className="font-mono text-sm bg-muted px-2 py-1 rounded-md">{coupon.code}</span>
      ),
    },
    {
      header: tTable('name'),
      cell: coupon => (
        <div>
          <p className="font-medium text-foreground">{coupon.name}</p>
          {coupon.nameAr && (
            <p className="text-sm text-muted-foreground" lang="ar" dir="rtl">
              {coupon.nameAr}
            </p>
          )}
        </div>
      ),
    },
    {
      header: tTable('type'),
      cell: coupon => <span className="text-sm text-muted-foreground">{typeLabel(coupon)}</span>,
    },
    {
      header: tTable('value'),
      cell: coupon => <span className="font-medium text-primary">{formatValue(coupon)}</span>,
    },
    {
      header: tTable('usage'),
      cell: coupon => (
        <span className="text-sm text-muted-foreground">
          {coupon.usageCount}
          {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}
        </span>
      ),
    },
    {
      header: tTable('status'),
      mobileBadge: true,
      cell: coupon => {
        const status = getCouponStatus(coupon);
        return (
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.color}`}
          >
            {tStatus(status.labelKey)}
          </span>
        );
      },
    },
    {
      header: tTable('actions'),
      alignEnd: true,
      mobileActions: true,
      cell: coupon => (
        <div className="flex items-center gap-2 md:justify-end">
          <RowActions
            menuLabel={tActions('menu', { code: coupon.code })}
            primary={
              <Button variant="outline" size="sm" type="button" onClick={() => onEdit(coupon)}>
                {tActions('edit')}
              </Button>
            }
            items={[
              {
                label: coupon.isActive ? tActions('deactivate') : tActions('activate'),
                onSelect: () => onToggleActive(coupon.id),
              },
              {
                label: tActions('delete'),
                destructive: true,
                onSelect: async () => {
                  const ok = await askConfirm({
                    object: tActions('deleteDialog.object', { code: coupon.code }),
                    consequence: tActions('deleteDialog.consequence'),
                    confirmLabel: tActions('deleteDialog.confirmLabel'),
                  });
                  if (ok) onDelete(coupon.id);
                },
              },
            ]}
          />
        </div>
      ),
    },
  ];

  const emptyState = (
    <EmptyState
      card
      icon="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
      title={tEmpty('title')}
      description={tEmpty('description')}
      action={{ label: tEmpty('createFirst'), onClick: onCreateFirst }}
    />
  );

  return (
    <DataTable<Coupon>
      ariaLabel={tTable('ariaLabel')}
      columns={columns}
      rows={coupons}
      rowKey={c => c.id}
      emptyState={emptyState}
    />
  );
}
