'use client';

import { useState } from 'react';
import { rememberOrderStatusLink } from '@/lib/order-view-token';
import { InstapayCard } from '../../checkout/success/InstapayCard';

/**
 * G54 (Ruling INSTAPAY-UPLOAD-1 part b): an InstaPay order opened from its signed order-status link (the WhatsApp
 * button) shows the same transfer instructions and receipt upload as the checkout success page. The link is handed to
 * the API client in memory only, for this order's InstaPay calls; the API checks it names this order and this store.
 */
export function OrderStatusInstapay({ orderId, token }: { orderId: string; token: string }) {
  // remember before the first render of the card, so its first fetch already carries the link
  useState(() => {
    rememberOrderStatusLink(orderId, token);
    return true;
  });
  return (
    <section className="mt-6" data-testid="order-status-instapay">
      <InstapayCard orderId={orderId} />
    </section>
  );
}
