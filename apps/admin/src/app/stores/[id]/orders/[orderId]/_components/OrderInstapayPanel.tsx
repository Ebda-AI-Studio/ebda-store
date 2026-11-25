'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import type { InstapayReceiptView } from '@ebda/shared';
import { apiGet, apiPost } from '../../../../../../lib/api';
import { InstapayReceiptReview } from '../../../../../../components/instapay/InstapayReceiptReview';
import { useT } from '@/i18n/useT';
import type { OrderDetail } from './types';

interface OrderInstapayPanelProps {
  order: OrderDetail;
  storeId: string;
  userRole?: 'super_admin' | 'store_admin' | 'customer' | 'staff';
  /** Opens the page's "payment received" confirmation (the approve action). */
  onApprove: () => void;
  isUpdating?: boolean;
  /** Re-fetch the order after a receipt was rejected. */
  onChanged: () => void;
}

/**
 * The shopper's InstaPay receipts on a store order, reviewed by the STORE OWNER
 * (or staff). Ebda's super-admin gets no order-receipt UI: the money went to the
 * merchant, so the API refuses them and so does this panel.
 */
export function OrderInstapayPanel({
  order,
  storeId,
  userRole,
  onApprove,
  isUpdating = false,
  onChanged,
}: OrderInstapayPanelProps) {
  const t = useT('instapayReceipt.order');
  const { success: toastSuccess } = useToast();
  const [receipts, setReceipts] = useState<InstapayReceiptView[] | null>(null);
  const [failed, setFailed] = useState(false);

  const isInstapay = order.payments?.some(p => p.provider === 'instapay') ?? false;
  const allowed = isInstapay && (userRole === 'store_admin' || userRole === 'staff');

  const load = useCallback(async () => {
    const { data, error } = await apiGet<{ receipts: InstapayReceiptView[] }>(
      `/api/v1/stores/${storeId}/orders/${order.id}/instapay-receipts`
    );
    setFailed(!!error);
    setReceipts(data?.receipts ?? []);
  }, [storeId, order.id]);

  // Refetch when the order moves (an approval changes its status/updatedAt).
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load, order.status, order.updatedAt]);

  if (!allowed) return null;

  async function reject(receiptId: string, note: string): Promise<string | null> {
    const { error } = await apiPost(
      `/api/v1/stores/${storeId}/orders/${order.id}/instapay-receipts/${receiptId}/reject`,
      { note }
    );
    if (error) return t('rejectFailed');
    toastSuccess(t('rejected'));
    await load();
    onChanged();
    return null;
  }

  return (
    <section
      className="rounded-lg border border-border bg-card p-5"
      data-testid="order-instapay-panel"
    >
      <h2 className="mb-1 text-sm font-medium text-muted-foreground uppercase tracking-wide">
        {t('title')}
      </h2>
      <p className="mb-4 text-xs text-muted-foreground">{t('subtitle')}</p>
      {receipts === null && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {failed && (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('failedToLoad')}
        </p>
      )}
      {receipts && receipts.length === 0 && !failed && (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
      <div className="space-y-5">
        {receipts?.map(r => (
          <div key={r.id} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
            <InstapayReceiptReview
              receipt={r}
              imageEndpoint={`/api/v1/stores/${storeId}/orders/${order.id}/instapay-receipts/${r.id}/image`}
              approveLabel={t('approve')}
              busy={isUpdating}
              onApprove={onApprove}
              onReject={note => reject(r.id, note)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
