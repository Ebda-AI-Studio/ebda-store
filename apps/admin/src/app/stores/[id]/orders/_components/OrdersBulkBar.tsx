'use client';

import { useT } from '@/i18n/useT';

interface OrdersBulkBarProps {
  selectedCount: number;
  isProcessing: boolean;
  onMarkPaid: () => void;
  onClearSelection: () => void;
}

export function OrdersBulkBar({
  selectedCount,
  isProcessing,
  onMarkPaid,
  onClearSelection,
}: OrdersBulkBarProps) {
  const t = useT('orders.list.bulk');

  if (selectedCount === 0) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
      <span className="text-sm font-medium text-foreground">
        {t('selected', { count: selectedCount })}
      </span>
      <button
        onClick={onMarkPaid}
        disabled={isProcessing}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {isProcessing ? t('processing') : t('markPaid')}
      </button>
      <button
        onClick={onClearSelection}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {t('clearSelection')}
      </button>
    </div>
  );
}
