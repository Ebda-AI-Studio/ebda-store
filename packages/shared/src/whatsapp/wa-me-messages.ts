/**
 * Prefilled `wa.me` message builders (AR + EN). Pure; money goes through
 * `formatMoney` (EGP), the store URL through `storefrontOrigin`.
 */

import { formatMoney, type RegionLocale } from '../region';
import { storefrontOrigin } from '../hosts';

export type WaMeLocale = RegionLocale;

const MAX_ITEM_LINES = 5;

export interface WaMeOrderItem {
  name: string;
  nameAr?: string | null;
  quantity: number;
}

export interface WaMeAddress {
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  /** Egyptian checkout fields (city/state are empty there). */
  area?: string | null;
  areaAr?: string | null;
  governorate?: string | null;
  governorateAr?: string | null;
}

function itemName(i: WaMeOrderItem, locale: WaMeLocale): string {
  return (locale === 'ar' && i.nameAr ? i.nameAr : i.name).trim();
}

/** "2× Name, 1× Other (+3 more)". */
export function summarizeItems(items: readonly WaMeOrderItem[], locale: WaMeLocale): string {
  const shown = items
    .slice(0, MAX_ITEM_LINES)
    .map(i => `${i.quantity}× ${itemName(i, locale)}`)
    .join(locale === 'ar' ? '، ' : ', ');
  const extra = items.length - MAX_ITEM_LINES;
  if (extra <= 0) return shown;
  return locale === 'ar' ? `${shown} (+${extra} أخرى)` : `${shown} (+${extra} more)`;
}

/** Short delivery address: street, area, governorate (city/state on legacy orders). */
export function shortAddress(a: WaMeAddress | null | undefined, locale: WaMeLocale = 'en'): string {
  if (!a) return '';
  const pick = (ar?: string | null, en?: string | null) =>
    ((locale === 'ar' ? ar || en : en || ar) ?? '').trim();
  const parts: string[] = [];
  for (const p of [
    (a.address1 ?? '').trim(),
    pick(a.areaAr, a.area),
    (a.city ?? '').trim(),
    pick(a.governorateAr, a.governorate) || (a.state ?? '').trim(),
  ]) {
    if (p && !parts.includes(p)) parts.push(p);
  }
  return parts.join(locale === 'ar' ? '، ' : ', ');
}

export interface CodConfirmationInput {
  locale: WaMeLocale;
  orderNumber: string;
  items: readonly WaMeOrderItem[];
  /** Order total, MINOR units (piastres). */
  totalMinor: number;
  address?: WaMeAddress | null;
  /** The delivery pick (deliveryLineFromNotes), when the order has one. */
  deliveryLine?: string | null;
  storeName?: string | null;
}

/** Customer → merchant: confirm a cash-on-delivery order. */
export function buildCodConfirmationMessage(i: CodConfirmationInput): string {
  const total = formatMoney(i.totalMinor, i.locale);
  const addr = shortAddress(i.address, i.locale);
  const items = summarizeItems(i.items, i.locale);
  if (i.locale === 'ar') {
    return [
      `مرحباً${i.storeName ? ` ${i.storeName}` : ''}، أريد تأكيد طلبي رقم #${i.orderNumber} (الدفع عند الاستلام).`,
      items && `الأصناف: ${items}`,
      `الإجمالي: ${total}`,
      addr && `عنوان التوصيل: ${addr}`,
      i.deliveryLine && `موعد التوصيل: ${i.deliveryLine}`,
      'رد بـ «نعم» للتأكيد.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Hello${i.storeName ? ` ${i.storeName}` : ''}, I'd like to confirm my cash-on-delivery order #${i.orderNumber}.`,
    items && `Items: ${items}`,
    `Total: ${total}`,
    addr && `Delivery address: ${addr}`,
    i.deliveryLine && `Delivery: ${i.deliveryLine}`,
    'Reply YES to confirm.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Customer → merchant: a question about an order. */
export function buildOrderQuestionMessage(i: {
  locale: WaMeLocale;
  orderNumber: string;
  storeName?: string | null;
}): string {
  return i.locale === 'ar'
    ? `مرحباً${i.storeName ? ` ${i.storeName}` : ''}، عندي سؤال بخصوص طلبي رقم #${i.orderNumber}.`
    : `Hello${i.storeName ? ` ${i.storeName}` : ''}, I have a question about my order #${i.orderNumber}.`;
}

/** Absolute product URL on the store's own origin (custom domain or `<slug>.ebda.app`). */
export function productUrl(
  store: { slug: string; domain?: string | null },
  productSlug: string
): string {
  return `${storefrontOrigin(store)}/products/${encodeURIComponent(productSlug)}`;
}

/** Share a product with a friend / ask the merchant about it. */
export function buildProductShareMessage(i: {
  locale: WaMeLocale;
  productName: string;
  /** MINOR units; omitted → no price line. */
  priceMinor?: number | null;
  url: string;
  /** The text the customer typed for this piece (e.g. the name to embroider). */
  personalisation?: { label: string; note: string } | null;
}): string {
  const price = typeof i.priceMinor === 'number' ? formatMoney(i.priceMinor, i.locale) : '';
  const head = price ? `${i.productName} — ${price}` : i.productName;
  const note = i.personalisation?.note
    ? `\n✎ ${i.personalisation.label}: ${i.personalisation.note}`
    : '';
  return i.locale === 'ar'
    ? `شوف ده: ${head}${note}\n${i.url}`
    : `Check this out: ${head}${note}\n${i.url}`;
}

/** Merchant shares their store link (setup-guide "share" item). */
export function buildStoreShareMessage(i: {
  locale: WaMeLocale;
  storeName: string;
  url: string;
}): string {
  return i.locale === 'ar'
    ? `متجري الجديد «${i.storeName}» أصبح مفتوحاً! تفضلوا بالزيارة:\n${i.url}`
    : `My new store "${i.storeName}" is open! Come take a look:\n${i.url}`;
}

const STATUS_AR: Record<string, string> = {
  pending: 'قيد المراجعة',
  confirmed: 'تم تأكيده',
  processing: 'قيد التجهيز',
  shipped: 'تم شحنه',
  delivered: 'تم تسليمه',
  cancelled: 'تم إلغاؤه',
  refunded: 'تم استرداد مبلغه',
};
const STATUS_EN: Record<string, string> = {
  pending: 'pending review',
  confirmed: 'confirmed',
  processing: 'being prepared',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  refunded: 'refunded',
};

/** Merchant → customer (merchant-initiated, from the admin orders page). */
export function buildOrderStatusMessage(i: {
  locale: WaMeLocale;
  orderNumber: string;
  status: string;
  customerName?: string | null;
  storeName?: string | null;
}): string {
  const name = (i.customerName ?? '').trim();
  const store = (i.storeName ?? '').trim();
  if (i.locale === 'ar') {
    const st = STATUS_AR[i.status] ?? i.status;
    return `مرحباً${name ? ` ${name}` : ''}، معك ${store || 'المتجر'}. طلبك رقم #${i.orderNumber} ${st}.`;
  }
  const st = STATUS_EN[i.status] ?? i.status;
  return `Hello${name ? ` ${name}` : ''}, this is ${store || 'the store'}. Your order #${i.orderNumber} is ${st}.`;
}
