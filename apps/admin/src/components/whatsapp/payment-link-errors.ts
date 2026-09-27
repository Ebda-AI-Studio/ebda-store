/**
 * Merchant copy for each failure `POST /stores/:id/payment-links` can answer
 * with (#1799). The route answers with the platform envelope, so `code` is
 * readable; this maps it to translated copy instead of showing the English
 * server message on an Arabic admin. An unknown code falls back to the server's
 * message, then to the generic "unknown error".
 */
export const PAYMENT_LINK_ERROR_KEYS: Record<string, string> = {
  INVALID_BODY: 'errInvalidBody',
  STORE_NOT_FOUND: 'errStoreNotFound',
  WBS_NOT_CONFIGURED: 'errWbsNotConfigured',
  TEMPLATE_NOT_FOUND: 'errTemplateNotFound',
  TEMPLATE_NOT_APPROVED: 'errTemplateNotApproved',
  PRODUCT_NOT_FOUND: 'errProductNotFound',
  OUT_OF_STOCK: 'errOutOfStock',
  PAYMENT_NOT_CONFIGURED: 'errPaymentNotConfigured',
  WBS_KEY_INVALID: 'errWbsKeyInvalid',
  WBS_SEND_FAILED: 'errWbsSendFailed',
};

export function paymentLinkErrorMessage(
  error: { code?: string; message?: string; details?: Record<string, unknown> },
  t: (key: string, values?: Record<string, string>) => string
): string {
  const key = error.code ? PAYMENT_LINK_ERROR_KEYS[error.code] : undefined;
  if (key) {
    const name = error.details?.productName;
    return t(key, { name: typeof name === 'string' ? name : '' });
  }
  return error.message || t('toastUnknownError');
}
