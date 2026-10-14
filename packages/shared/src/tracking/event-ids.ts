/**
 * Deterministic event ids that pair the browser event with its server (Conversions API)
 * twin, so Meta counts one conversion. Both sides derive the id from the same record id.
 */
export const registrationEventId = (userId: string): string => `reg_${userId}`;
export const storeCreatedEventId = (storeId: string): string => `store_${storeId}`;
/** Server-only: a paid subscription has no browser twin (the payment is confirmed server-side). */
export const purchaseEventId = (billingEventId: string): string => `sub_${billingEventId}`;
