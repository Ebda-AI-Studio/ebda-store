/**
 * What checkout does with the `/payments/create` answer.
 *
 * The saved checkout form (and the applied promo code) are cleared ONLY on a
 * success branch, right before the customer leaves the page. They used to be
 * cleared before the result was even checked, so a failed payment (a gateway
 * timeout after the order was rolled back, a rejected invoice) destroyed the
 * form the customer had just typed: a reload, the error page or the gateway's
 * back button all came back to an empty checkout (#1990).
 */
export interface PaymentCreateResult {
  success: boolean;
  data?: { paymentUrl?: string; cod?: boolean };
  error?: { code?: string; message?: string };
}

export interface PaymentResultActions {
  clearSavedCheckout: () => void;
  goToCodSuccess: () => void;
  goToGateway: (paymentUrl: string) => void;
}

/**
 * Runs the success branch, or throws an Error whose message is the API error
 * code (the checkout catch maps codes to customer copy) with the raw message
 * attached as `rawMessage` for the console only.
 */
export function handlePaymentCreateResult(
  result: PaymentCreateResult,
  actions: PaymentResultActions
): void {
  if (result.success && result.data?.cod) {
    // Cash on delivery — go straight to success.
    actions.clearSavedCheckout();
    actions.goToCodSuccess();
    return;
  }
  if (result.success && result.data?.paymentUrl) {
    // Online payment — redirect to the payment gateway.
    actions.clearSavedCheckout();
    actions.goToGateway(result.data.paymentUrl);
    return;
  }
  const err = new Error(result.error?.code || 'PAYMENT_FAILED');
  (err as Error & { rawMessage?: string }).rawMessage = result.error?.message || '';
  throw err;
}
