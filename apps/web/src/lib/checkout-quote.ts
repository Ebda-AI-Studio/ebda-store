/**
 * The checkout's server quote (B2B design review I-1, Ruling B2B-9).
 *
 * The total the buyer confirms is the one the SERVER computes (`POST /public/orders/quote`, which runs the real order
 * creation in dry-run mode), never a number the browser assembled from catalogue prices. It is sent back as
 * `expectedTotal`; if the server then prices the order differently (approval revoked, tier edited, plan changed) it
 * answers 409 PRICE_CHANGED and the buyer confirms the NEW total. Pure helpers, tested on real values.
 */

export interface OrderQuote {
  subtotal: number;
  discount: number;
  shipping: number;
  codFee: number;
  tax: number;
  total: number;
  taxIncludedInPrice: boolean;
  lines: Array<{
    itemId: string;
    productId: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    listPrice: number;
    priceSource: 'base' | 'tier' | 'group';
    priceTierMinQty: number | null;
  }>;
}

export interface QuoteInputs {
  area: string;
  governorate: string;
  country: string;
  phone: string;
  email: string;
  /** Payment provider id, `provider:method` accepted (only the provider part reaches the server). */
  selectedProvider: string;
  couponCode?: string | null;
  pointsToRedeem?: number;
}

/** The body for POST /public/orders/quote: only what can change the total (area -> shipping, provider -> COD fee, coupon, points). */
export function buildQuoteRequest(i: QuoteInputs) {
  return {
    shippingAddress: {
      area: i.area || undefined,
      governorate: i.governorate || undefined,
      country: i.country || undefined,
      phone: i.phone.trim() || undefined,
      email: i.email.trim() || undefined,
    },
    paymentMethod: i.selectedProvider.split(':')[0],
    couponCode: i.couponCode || undefined,
    pointsToRedeem: i.pointsToRedeem && i.pointsToRedeem > 0 ? i.pointsToRedeem : undefined,
  };
}

/** Identity of one quote request PLUS the cart it was priced for: any change makes the held quote stale. */
export function quoteKey(
  i: QuoteInputs,
  cartLines: ReadonlyArray<{ id: string; quantity: number; price: number }>,
  nonce = 0
): string {
  return JSON.stringify([
    buildQuoteRequest(i),
    cartLines.map(l => [l.id, l.quantity, l.price]),
    nonce,
  ]);
}

export interface HeldQuote {
  key: string;
  quote: OrderQuote;
}

/** The quote to DISPLAY and to send: only one computed for exactly the current inputs and cart; never a stale one. */
export function freshQuote(held: HeldQuote | null, currentKey: string): OrderQuote | null {
  return held && held.key === currentKey ? held.quote : null;
}

/** `expectedTotal` for POST /public/orders: the displayed server total, or undefined when no fresh quote exists. */
export function expectedTotalFor(held: HeldQuote | null, currentKey: string): number | undefined {
  return freshQuote(held, currentKey)?.total;
}

/**
 * QA-COUPON-1: the total the buyer is shown, ALWAYS sent as `expectedTotal`. With a fresh server quote it is that quote's
 * total; with none (the quote request failed, or is still in flight) it is the local estimate on screen. Either way the
 * server compares it with what it would charge and answers 409 PRICE_CHANGED on any difference, so a dropped coupon, a
 * stale estimate or a repricing can never become a silent charge of more than the buyer saw. Never `undefined`.
 */
export function expectedTotalToSend(
  held: HeldQuote | null,
  currentKey: string,
  shownTotal: number
): number {
  return expectedTotalFor(held, currentKey) ?? Math.max(0, Math.round(shownTotal));
}

/**
 * The 409 PRICE_CHANGED message. `newTotal` is the server's new total (piastres) formatted by the caller's formatter, so the
 * buyer sees the exact figure they are being asked to confirm. Falls back to copy without a figure when none was sent.
 */
export function priceChangedCopy(
  details: { total?: unknown } | null | undefined,
  formatPrice: (minor: number) => string,
  t: (en: string, ar: string) => string
): string {
  const total = typeof details?.total === 'number' ? details.total : null;
  if (total === null) {
    return t(
      'Prices changed since you last saw your cart. Please review the new total and confirm your order.',
      'الأسعار اتغيّرت من آخر مرة شفت فيها سلتك. راجع الإجمالي الجديد وأكّد طلبك.'
    );
  }
  const shown = formatPrice(total);
  return t(
    `Prices changed since you last saw your cart. Your new total is ${shown}. Press Place order again to confirm it.`,
    `الأسعار اتغيّرت من آخر مرة شفت فيها سلتك. إجمالي طلبك الجديد ${shown}. دوس «تأكيد الطلب» تاني عشان تأكّده.`
  );
}
