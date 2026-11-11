/**
 * Zod at the edge of the `WhatsAppBridge` commerce RPC (contract section 5 + the InstaPay addendum).
 * The shapes mirror ebda-whatsapp `src/core/store-bridge.ts`; `tests/unit/wa-bridge-contract.test.ts` runs BOTH sides
 * against the shared fixtures in `tests/vectors/ebda-wa/bridge-v1.json`, so a one-sided drift fails here.
 * Amounts are integer minor units (piasters). Nothing here trusts a price from the caller.
 */
import { z } from 'zod';

export const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const chatPaymentMethod = z.enum(['cod', 'link', 'instapay']);
export const buyerKey = z.string().regex(/^[0-9a-f]{64}$/);
export const orderLine = z.object({
  variantId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(99),
});
export const buyer = z.object({
  buyerKey,
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  name: z.string().max(120).nullable(),
  locale: z.enum(['ar', 'en']),
});
export const newAddress = z.object({
  label: z.string().max(40).optional(),
  area: z.string().min(1).max(120),
  street: z.string().min(1).max(240),
});
const items = z.array(orderLine).min(1).max(50);
const idemKey = z.string().min(8).max(128);

export const args = {
  storeId: UUID,
  listCatalog: z.object({
    cursor: z.string().max(200).nullable(),
    limit: z.number().int().min(1).max(100),
  }),
  getProducts: z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }),
  createCheckoutLink: z.object({ items, buyer }),
  createOrderFromChat: z
    .object({
      items,
      buyer,
      addressId: z.string().min(1).max(64).optional(),
      address: newAddress.optional(),
      paymentMethod: chatPaymentMethod,
      idempotencyKey: idemKey,
    })
    .refine(v => Boolean(v.addressId) !== Boolean(v.address), {
      message: 'exactly one of addressId / address',
    }),
  getPaymentLink: z.object({ orderId: z.string().min(1).max(64) }),
  recordCodOutcome: z.object({
    orderId: z.string().min(1).max(64),
    outcome: z.enum(['confirmed', 'refused', 'no_reply']),
    at: z.string().datetime({ offset: true }),
    idempotencyKey: idemKey,
  }),
  attachPaymentProof: z.object({
    orderId: z.string().min(1).max(64),
    mediaUrl: z.string().url().max(2000).startsWith('https://'),
  }),
  buyerKey: z.object({ buyerKey }),
  saveCustomerAddress: z.object({ buyerKey, address: newAddress }),
  getOrderStatus: z.object({ orderNumber: z.string().min(1).max(40), buyerKey }),
  listCustomerOrders: z.object({ buyerKey, limit: z.number().int().min(1).max(20) }),
};
