/**
 * Shopper-facing copy for order-creation failures that need their own message.
 * Pure (takes `t`) so it is unit tested without mounting CheckoutClient.
 */
export function subscriptionRequiredCopy(code: string, t: (en: string, ar: string) => string) {
  if (code !== 'SUBSCRIPTION_REQUIRED') return null;
  return t(
    'This store is not taking orders right now. Please try again later.',
    'المتجر مش بيستقبل طلبات دلوقتي. جرّب تاني بعدين.'
  );
}
