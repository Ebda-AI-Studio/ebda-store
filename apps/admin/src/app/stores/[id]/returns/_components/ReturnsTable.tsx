'use client';

import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { RETURN_COLORS } from './types';
import type { ListMeta, ReturnRecord } from './types';

import { formatDate } from '@/lib/format';

import { formatMoney } from '@ebda/shared';
function formatCurrency(amount: number) {
  return formatMoney(amount, 'en', { fixedDecimals: true });
}

interface ReturnsTableProps {
  returns: ReturnRecord[];
  meta: ListMeta;
  isLoading: boolean;
  onSelect: (ret: ReturnRecord) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onMarkReceived: (id: string) => void;
  onComplete: (id: string) => void;
  onPageChange: (page: number) => void;
}

/**
 * Paginated list of return requests with inline action buttons keyed off the
 * return's current status. Row click opens the details drawer via `onSelect`.
 */
export function ReturnsTable({
  returns,
  meta,
  isLoading,
  onSelect,
  onApprove,
  onReject,
  onMarkReceived,
  onComplete,
  onPageChange,
}: ReturnsTableProps) {
  const t = useT('returns.list');
  const tType = useT('returns.type');

  return (
    <div className="rounded-md border bg-card shadow-sm">
      {isLoading ? (
        <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>
      ) : returns.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground">{t('empty')}</div>
      ) : (
        <div className="divide-y">
          {returns.map(ret => (
            <div
              key={ret.id}
              className="p-6 hover:bg-muted cursor-pointer"
              onClick={() => onSelect(ret)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="font-semibold text-foreground">#{ret.returnNumber}</span>
                    <OrderStatusBadge
                      status={ret.status}
                      namespace="returns.status"
                      colorMap={RETURN_COLORS}
                    />
                    <Badge variant="outline">{tType(ret.type)}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    <span className="font-medium">{t('orderLabel')}:</span> #{ret.order.orderNumber}{' '}
                    |<span className="font-medium ms-2">{t('customerLabel')}:</span>{' '}
                    {ret.customer.firstName} {ret.customer.lastName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium">{t('reasonLabel')}:</span> {ret.reason}
                  </p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span>{formatDate(ret.createdAt)}</span>
                    <span>{t('itemCount', { count: ret.items.length })}</span>
                    <span className="font-medium text-foreground">
                      {formatCurrency(ret.refundAmount)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {ret.status === 'pending' && (
                    <>
                      <Button
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          onApprove(ret.id);
                        }}
                      >
                        {t('actions.approve')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          onReject(ret.id);
                        }}
                      >
                        {t('actions.reject')}
                      </Button>
                    </>
                  )}
                  {ret.status === 'approved' && (
                    <Button
                      size="sm"
                      onClick={e => {
                        e.stopPropagation();
                        onMarkReceived(ret.id);
                      }}
                    >
                      {t('actions.markReceived')}
                    </Button>
                  )}
                  {(ret.status === 'received' || ret.status === 'inspecting') && (
                    <Button
                      size="sm"
                      onClick={e => {
                        e.stopPropagation();
                        onComplete(ret.id);
                      }}
                    >
                      {t('actions.completeRefund')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-6 py-3">
          <p className="text-sm text-muted-foreground">
            {t('pagination', {
              from: (meta.page - 1) * meta.limit + 1,
              to: Math.min(meta.page * meta.limit, meta.total),
              total: meta.total,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={meta.page === 1}
              onClick={() => onPageChange(meta.page - 1)}
            >
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              disabled={meta.page === meta.totalPages}
              onClick={() => onPageChange(meta.page + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
