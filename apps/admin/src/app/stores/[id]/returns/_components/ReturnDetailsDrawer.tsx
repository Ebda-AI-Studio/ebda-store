'use client';

import Image from 'next/image';
import { Button, Badge } from '@force/ui';
import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { ReturnLifecycleTimeline } from '../../../../../components/return-timeline/ReturnLifecycleTimeline';
import { RETURN_COLORS } from './types';
import type { ReturnRecord } from './types';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(amount / 1000);
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

  if (!open || !record) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl shadow-lg max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
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

          {/* Items */}
          <div>
            <h3 className="font-medium text-foreground mb-2">{t('items')}</h3>
            <div className="space-y-2">
              {record.items.map(item => (
                <div key={item.id} className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                  {item.product?.images?.[0]?.url ? (
                    <Image
                      src={item.product.images[0].url}
                      alt=""
                      width={48}
                      height={48}
                      className="w-12 h-12 rounded object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded bg-muted flex items-center justify-center">
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
              ))}
            </div>
          </div>

          {/* Refund Info */}
          <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
            <span className="font-medium text-foreground">{t('refundAmount')}</span>
            <span className="text-lg font-bold text-primary">
              {formatCurrency(record.refundAmount)}
            </span>
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
