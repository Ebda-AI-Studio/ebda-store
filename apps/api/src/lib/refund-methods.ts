/**
 * The refund methods a return can be completed with, in a module with no
 * imports so both the returns service and the GL poster can read the same
 * set (the poster picks the account a partial return credits from it — owner
 * decision 2026-10-01, see docs/RULINGS.md M1-8).
 *
 * Refund methods that mean "send the money back through the payment provider".
 * They drifted apart once already: the service matched `'gateway'` and
 * `'original_payment'` while the admin has always sent `'original'`, so the
 * gateway branch was unreachable and the failure was silent — an unknown
 * method simply fell through to the manual path, which looks like a successful
 * completion.
 */
export const GATEWAY_REFUND_METHODS = ['original', 'gateway', 'original_payment'] as const;

/** Every method the completion endpoint accepts. Anything else is rejected. */
export const REFUND_METHODS = [
  ...GATEWAY_REFUND_METHODS,
  'store_credit',
  'bank_transfer',
  'cash',
  'manual',
] as const;

export function isGatewayRefundMethod(method: string | null | undefined): boolean {
  return (GATEWAY_REFUND_METHODS as readonly string[]).includes(method ?? '');
}

/**
 * Wallet ledger idempotency key for the part of a gateway refund that goes
 * back to the customer wallet because the order was partly paid from it
 * (#1956). Distinct from `return-credit:<id>` (store credit chosen as the
 * method), so the two can never replay into each other.
 */
export function returnWalletShareKey(returnId: string): string {
  return `return-wallet-share:${returnId}`;
}
export const RETURN_WALLET_SHARE_KEY_PREFIX = 'return-wallet-share:';

/**
 * `order/refunded` refundKey (and GL key suffix) for a partial refund made
 * outside a return: one ledger entry per provider refund id (#1209, #1455).
 */
export function amountOnlyRefundKey(providerRefundId: string): string {
  return `refund:${providerRefundId}`;
}
