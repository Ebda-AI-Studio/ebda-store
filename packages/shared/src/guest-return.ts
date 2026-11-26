/**
 * GUEST-RET-1: `returns.customer_id` is NOT NULL and a guest order has no account, so a merchant-opened return on a guest order
 * stores `guest:<orderId>` there. It is never a users.id: no wallet, loyalty, email or socket may be resolved from it.
 * `packages/repo` cannot import this package (see revenue.ts), so it keeps an identical copy in do/returns.ts;
 * guest-return.test.ts guards that the two agree.
 */
export const GUEST_RETURN_PREFIX = 'guest:';
export const guestReturnCustomerId = (orderId: string): string =>
  `${GUEST_RETURN_PREFIX}${orderId}`;
export const isGuestReturnCustomer = (customerId: unknown): boolean =>
  typeof customerId === 'string' && customerId.startsWith(GUEST_RETURN_PREFIX);
