'use client';

import {
  buildOrderStatusMessage,
  resolveDefaultLanguage,
  waMeLink,
  type WaMeLocale,
} from '@ebda/shared';
import { useCurrentStore } from '@/hooks/useCurrentStore';
import type { OrderDetail } from './types';

/**
 * Merchant-initiated `wa.me` link to the customer's phone, prefilled with an
 * order-status text in the order's / store's language. `null` when the phone
 * is missing or not an Egyptian mobile (the button is then hidden). Free tier:
 * opens WhatsApp for the merchant to press send — no API call.
 */
export function useMessageCustomerHref(
  order: Pick<OrderDetail, 'storeId' | 'orderNumber' | 'status'> & { locale?: string | null },
  phone: string,
  customerName?: string
): string | null {
  const { store } = useCurrentStore(order.storeId);
  const raw =
    order.locale ?? (store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage;
  const locale: WaMeLocale = resolveDefaultLanguage(raw);
  return waMeLink(
    phone,
    buildOrderStatusMessage({
      locale,
      orderNumber: order.orderNumber,
      status: order.status,
      customerName,
      storeName: locale === 'ar' && store?.nameAr ? store.nameAr : store?.name,
    })
  );
}
