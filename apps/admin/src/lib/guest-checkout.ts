/**
 * Counts built on `abandoned_carts` (abandoned-cart stats, the funnel's
 * "checkouts started" and "abandoned") cannot see a guest cart: detection needs
 * a customer contact, and guest checkout captures none (owner decision
 * 2026-09-30 — no guest contact capture). On a store that takes guest orders
 * (the API's `guestCheckout` flag) such a count of 0 means "not tracked", not
 * "none happened", and is shown as such. A non-zero count on the same store is
 * real but covers registered customers only.
 */
export function isUntrackedForGuests(value: number, guestCheckout: boolean | undefined): boolean {
  return guestCheckout === true && value === 0;
}
