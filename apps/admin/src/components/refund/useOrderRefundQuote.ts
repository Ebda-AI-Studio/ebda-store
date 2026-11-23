'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useLatestRequest } from '../../hooks/useLatestRequest';

/** STORE-QA-76: the API's `GET /orders/:id/refund-quote` answer (figures in piastres). */
export interface RefundQuote {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  currency: string;
  customerId: string | null;
  total: number;
  paid: number;
  refunded: number;
  /** the ONE refundable balance across every channel; the server refuses more than this */
  refundable: number;
  paymentProvider: string | null;
  returnable: { ok: true } | { ok: false; reason: 'NOT_DELIVERED' | 'GUEST_ORDER' };
  lines: Array<{
    orderItemId: string;
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    remaining: number;
    trackInventory: boolean;
    bundleGroupId: string | null;
  }>;
  estimate: number | null;
  coversWholeOrder: boolean;
  canRefundToOriginal: boolean;
}

interface LineChoice {
  checked: boolean;
  quantity: number;
  restock: boolean;
}
export type Selection = Record<string, LineChoice>;

export const emptySelection = (quote: RefundQuote): Selection =>
  Object.fromEntries(
    quote.lines.map(l => [l.orderItemId, { checked: false, quantity: l.remaining, restock: true }])
  );

/** The wire items of a selection: only ticked lines, quantity clamped to what is still open. */
export function selectionItems(quote: RefundQuote, sel: Selection) {
  return quote.lines
    .filter(l => sel[l.orderItemId]?.checked && l.remaining > 0)
    .map(l => ({
      orderItemId: l.orderItemId,
      quantity: Math.max(1, Math.min(l.remaining, Math.floor(sel[l.orderItemId].quantity) || 1)),
      restock: l.trackInventory ? sel[l.orderItemId].restock : undefined,
    }));
}

/**
 * Loads the quote for an order and re-quotes (the estimate) whenever the selection changes. `errorCode` is the API's code, so the
 * caller shows its own bilingual copy (the API text is English-only).
 */
export function useOrderRefundQuote(
  storeId: string,
  orderId: string | null,
  sel: Selection | null
) {
  const begin = useLatestRequest();
  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const itemsParam = useMemo(() => {
    if (!quote || !sel) return '';
    const items = selectionItems(quote, sel).map(i => ({
      orderItemId: i.orderItemId,
      quantity: i.quantity,
    }));
    return items.length ? JSON.stringify(items) : '';
  }, [quote, sel]);

  useEffect(() => {
    if (!orderId) {
      setQuote(null);
      return;
    }
    const isLatest = begin();
    setLoading(true);
    setErrorCode(null);
    const qs = itemsParam ? `?items=${encodeURIComponent(itemsParam)}` : '';
    void apiGet<{ quote: RefundQuote }>(
      `/api/v1/stores/${storeId}/orders/${orderId}/refund-quote${qs}`
    ).then(({ data, error }) => {
      if (!isLatest()) return;
      setLoading(false);
      if (error || !data) {
        setErrorCode(error?.code ?? 'UNKNOWN');
        if (!quote) setQuote(null);
        return;
      }
      setQuote(data.quote);
    });
    // `quote` is deliberately not a dependency: it is the OUTPUT of this effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, orderId, itemsParam, begin]);

  return { quote, loading, errorCode };
}
