/**
 * A store's order-notification address: `settings.orderInvoiceEmail`, trimmed, or null.
 * The ONLY address order emails carrying shopper data go to (Ruling FU46-1a): the invoice
 * of every order, and the refund alert. Never Ebda's own address; unset = nothing is sent.
 */
export function resolveOrderInvoiceRecipient(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const value = (settings as { orderInvoiceEmail?: unknown }).orderInvoiceEmail;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
