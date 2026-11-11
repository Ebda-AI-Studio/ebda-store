'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useFeatures } from '@/hooks/useFeatures';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { ReturnLifecycleTimeline } from '../../../../../components/return-timeline/ReturnLifecycleTimeline';
import { RETURN_COLORS } from './types';
import type { ReturnItem, ReturnRecord } from './types';

import { formatMoney } from '@ebda/shared';
function formatCurrency(amount: number) {
  return formatMoney(amount, 'en', { fixedDecimals: true });
}

export type ReturnDetailsEntry =
  | { kind: 'item'; item: ReturnItem }
  | {
      kind: 'group';
      bundleGroupId: string;
      name: string;
      nameAr: string | null;
      items: ReturnItem[];
    };

/**
 * Groups a return's `ReturnItem[]` by the bundle box they came back from —
 * mirroring the order detail's `groupItemsForAdmin` (admin `ItemsCard.tsx`),
 * but over `ReturnItem` (no `price`/`total` field to collapse). Bundle
 * returns are ATOMIC (`ReturnService.create` refuses a component named
 * outside `bundleGroupIds` with `bundle_returns_are_atomic`), so every
 * `ReturnItem` sharing a `bundleGroupId` is one box's full, unsplit
 * component set — never a partial return of it. A merchant inspecting a
 * return must see "these 3 products came back together as Ramadan Box", not
 * 3 unrelated returned products.
 */
export function groupReturnItems(items: ReturnItem[]): ReturnDetailsEntry[] {
  const entries: ReturnDetailsEntry[] = [];
  const groupIndex = new Map<string, number>();

  for (const item of items) {
    const bundleGroupId = item.orderItem?.bundleGroupId;
    if (bundleGroupId) {
      const idx = groupIndex.get(bundleGroupId);
      if (idx === undefined) {
        groupIndex.set(bundleGroupId, entries.length);
        entries.push({
          kind: 'group',
          bundleGroupId,
          name: item.orderItem?.bundleName ?? 'Bundle',
          nameAr: item.orderItem?.bundleNameAr ?? null,
          items: [item],
        });
      } else {
        const existing = entries[idx];
        if (existing.kind === 'group') existing.items.push(item);
      }
    } else {
      entries.push({ kind: 'item', item });
    }
  }

  return entries;
}

interface ReturnDetailsDrawerProps {
  record: ReturnRecord | null;
  open: boolean;
  storeId: string;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onMarkReceived: (id: string) => void;
  onComplete: (id: string) => void;
}

/**
 * Modal/drawer showing the full return detail with inline action buttons.
 * Rendered as a fixed overlay. Backdrop click and close button both dismiss
 * the drawer via `onClose`.
 */
export function ReturnDetailsDrawer({
  record,
  open,
  storeId,
  onClose,
  onApprove,
  onReject,
  onMarkReceived,
  onComplete,
}: ReturnDetailsDrawerProps) {
  const t = useT('returns.details');
  const tType = useT('returns.type');
  const { isEnabled: isFeatureEnabled, isLoading: featuresLoading } = useFeatures();
  const walletEnabled = !featuresLoading && isFeatureEnabled('customer_wallet');

  if (!open || !record) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-md shadow-md max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 className="font-semibold text-foreground">
              {t('heading', { number: record.returnNumber })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('orderReference', { number: record.order.orderNumber })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="text-muted-foreground hover:text-muted-foreground"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="p-6 space-y-6">
          {/* Status & Type */}
          <div className="flex items-center gap-3">
            <OrderStatusBadge
              status={record.status}
              namespace="returns.status"
              colorMap={RETURN_COLORS}
            />
            <Badge variant="outline">{tType(record.type)}</Badge>
          </div>

          {/* Customer Info */}
          <div>
            <h3 className="font-medium text-foreground mb-2">{t('customer')}</h3>
            <p className="text-sm text-muted-foreground">
              {record.customer.firstName} {record.customer.lastName}
            </p>
            <p className="text-sm text-muted-foreground">{record.customer.email}</p>
          </div>

          {/* Reason */}
          <div>
            <h3 className="font-medium text-foreground mb-2">{t('reason')}</h3>
            <p className="text-sm text-muted-foreground">{record.reason}</p>
            {record.reasonDetail && (
              <p className="text-sm text-muted-foreground mt-1">{record.reasonDetail}</p>
            )}
          </div>

          {/* Items — a bundle box's components are grouped under the
              box's name (see `groupReturnItems`); returns are atomic, so
              every component of a named group came back together. */}
          <div>
            <h3 className="font-medium text-foreground mb-2">{t('items')}</h3>
            <div className="space-y-2">
              {groupReturnItems(record.items).map(entry =>
                entry.kind === 'group' ? (
                  <BundleGroup key={entry.bundleGroupId} entry={entry} />
                ) : (
                  <ReturnItemRow key={entry.item.id} item={entry.item} />
                )
              )}
            </div>
          </div>

          {/* Refund Info */}
          <div className="p-4 bg-muted rounded-lg">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{t('refundAmount')}</span>
              <span className="text-lg font-bold text-primary">
                {formatCurrency(record.refundAmount)}
              </span>
            </div>
            {/* Customer wallet (D1): a completed store-credit refund landed in
                the wallet — only true while the feature is on. */}
            {walletEnabled &&
              record.status === 'completed' &&
              record.refundMethod === 'store_credit' && (
                <p className="mt-1 text-xs text-muted-foreground">{t('creditedToWallet')}</p>
              )}
          </div>

          {/* Lifecycle timeline — collapsible, read-only audit trail */}
          <ReturnLifecycleTimeline storeId={storeId} returnId={record.id} />

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t">
            {record.status === 'pending' && (
              <>
                <Button className="flex-1" onClick={() => onApprove(record.id)}>
                  {t('actions.approveReturn')}
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => onReject(record.id)}>
                  {t('actions.reject')}
                </Button>
              </>
            )}
            {record.status === 'approved' && (
              <Button className="flex-1" onClick={() => onMarkReceived(record.id)}>
                {t('actions.markReceived')}
              </Button>
            )}
            {(record.status === 'received' || record.status === 'inspecting') && (
              <Button className="flex-1" onClick={() => onComplete(record.id)}>
                {t('actions.completeRefund')}
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              {t('actions.close')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BundleGroup({ entry }: { entry: Extract<ReturnDetailsEntry, { kind: 'group' }> }) {
  const t = useT('returns.details');
  const locale = useLocale();
  const name = locale === 'ar' && entry.nameAr ? entry.nameAr : entry.name;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('bundleBadge')}
        </span>
        <p className="text-sm font-semibold text-foreground">{name}</p>
      </div>
      {/* Every component of the box, individually visible — returns are
          atomic, so this is always the box's FULL, unsplit component set.
          Each component row keeps the SAME styling a standalone (non-bundle)
          return line uses — only the indentation + badge are new. */}
      <div className="ms-3 space-y-2 border-s-2 border-border/60 ps-3">
        {entry.items.map(item => (
          <ReturnItemRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function ReturnItemRow({ item }: { item: ReturnItem }) {
  const t = useT('returns.details');
  return (
    <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
      {item.product?.images?.[0]?.url ? (
        <Image
          src={item.product.images[0].url}
          alt=""
          width={48}
          height={48}
          className="w-12 h-12 rounded-md object-cover"
        />
      ) : (
        <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center">
          <svg
            className="w-6 h-6 text-muted-foreground"
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
      )}
      <div className="flex-1">
        <p className="font-medium text-foreground">{item.productName}</p>
        <p className="text-sm text-muted-foreground">
          {t('itemMeta', {
            qty: item.quantity,
            condition: item.condition || t('notAvailable'),
          })}
        </p>
      </div>
    </div>
  );
}
