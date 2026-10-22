/**
 * Id field names on the WBS bridge wire (Ebda <-> WBS, separate service).
 * New names: ebdaStoreId / ebdaOrderId. For one release we SEND both the new and
 * the previous names (WBS may not have deployed yet) and ACCEPT either inbound.
 *
 * TODO(2026-12-01): once WBS reads/writes the new names, delete the previous
 * ones here and drop this file from tests/unit/branding-allowlist.json.
 */
import { z } from 'zod';

export const WBS_WIRE_LEGACY_REMOVE_AFTER = '2026-12-01';

export function storeIdFields(storeId: string): { ebdaStoreId: string; fwbStoreId: string } {
  return { ebdaStoreId: storeId, fwbStoreId: storeId };
}

export function orderIdFields(
  orderId: string | undefined
): { ebdaOrderId: string; fwbOrderId: string } | Record<string, never> {
  return orderId ? { ebdaOrderId: orderId, fwbOrderId: orderId } : {};
}

/** Store id a WBS cart payload is bound to: new field, then the previous one, else null. */
export function cartStoreId(cart: {
  ebdaStoreId?: string | null;
  fwbStoreId?: string | null;
}): string | null {
  return cart.ebdaStoreId ?? cart.fwbStoreId ?? null;
}

/** Inbound `POST /templates/status` body. Either store id field is accepted; `storeId` is the result. */
export const templateStatusSchema = z
  .object({
    ebdaStoreId: z.string().min(1).optional(),
    fwbStoreId: z.string().min(1).optional(),
    sourceKey: z.string().nullable().optional(),
    templateName: z.string().min(1),
    language: z.string().min(1),
    status: z.enum(['draft', 'pending', 'approved', 'rejected', 'paused', 'disabled']),
    rejectionReason: z.string().nullable().optional(),
    metaTemplateId: z.string().nullable().optional(),
  })
  .refine(b => !!(b.ebdaStoreId ?? b.fwbStoreId), { message: 'store id required' })
  .transform(b => ({ ...b, storeId: (b.ebdaStoreId ?? b.fwbStoreId) as string }));
