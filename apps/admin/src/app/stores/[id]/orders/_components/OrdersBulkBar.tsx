'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { PACKING_SLIP_MAX } from '../../../../../components/orders/PackingSlipViewer';

import { Button, buttonVariants } from '@/components/ui/Button';
interface OrdersBulkBarProps {
  /** With `selectedIds`, enables "print packing slips" for the selection. */
  storeId?: string;
  selectedIds?: string[];
  selectedCount: number;
  isProcessing: boolean;
  onMarkPaid: () => void;
  onClearSelection: () => void;
}

export function OrdersBulkBar({
  storeId,
  selectedIds = [],
  selectedCount,
  isProcessing,
  onMarkPaid,
  onClearSelection,
}: OrdersBulkBarProps) {
  const t = useT('orders.list.bulk');
  const tSlip = useT('packingSlip');

  if (selectedCount === 0) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
      <span className="text-sm font-medium text-foreground">
        {t('selected', { count: selectedCount })}
      </span>
      <Button
        type="button"
        onClick={onMarkPaid}
        disabled={isProcessing}
        variant="default"
        size="sm"
        className="gap-1.5"
      >
        {isProcessing ? t('processing') : t('markPaid')}
      </Button>
      {storeId && selectedIds.length > 0 && (
        <span className="inline-flex items-center gap-2">
          {selectedIds.length > PACKING_SLIP_MAX ? (
            <span role="note" className="text-xs text-muted-foreground">
              {tSlip('tooMany')}
            </span>
          ) : (
            <Link
              href={`/stores/${storeId}/orders/packing-slips?ids=${selectedIds.join(',')}`}
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1.5' })}
            >
              {tSlip('printBulk', { count: selectedIds.length })}
            </Link>
          )}
        </span>
      )}
      <Button
        type="button"
        onClick={onClearSelection}
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
      >
        {t('clearSelection')}
      </Button>
    </div>
  );
}
