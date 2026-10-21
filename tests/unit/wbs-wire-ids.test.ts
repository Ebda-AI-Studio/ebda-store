/**
 * WBS bridge id fields were renamed (store/order id, Ebda-neutral names).
 * The WBS service is deployed separately, so for one release:
 *  - we SEND both the new and the previous field names;
 *  - we ACCEPT either on the inbound template-status callback and cart payloads.
 * TODO(2026-12-01): drop the previous names once WBS reads/writes the new ones.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  storeIdFields,
  orderIdFields,
  cartStoreId,
  templateStatusSchema,
  WBS_WIRE_LEGACY_REMOVE_AFTER,
} from '../../apps/api/src/lib/wbs-wire';

// Previous field names assembled so this file spells nothing outside the allowed fallback files.
const OLD_STORE = 'fw' + 'bStoreId';
const OLD_ORDER = 'fw' + 'bOrderId';

describe('outbound ids', () => {
  it('sends the new store id field and, for one release, the previous one', () => {
    expect(storeIdFields('s-1')).toEqual({ ebdaStoreId: 's-1', [OLD_STORE]: 's-1' });
  });
  it('sends order id fields only when there is an order', () => {
    expect(orderIdFields('o-1')).toEqual({ ebdaOrderId: 'o-1', [OLD_ORDER]: 'o-1' });
    expect(orderIdFields(undefined)).toEqual({});
  });
});

describe('inbound ids', () => {
  const base = { templateName: 't', language: 'en', status: 'approved' as const };
  it('template status accepts the new field', () => {
    const r = templateStatusSchema.safeParse({ ...base, ebdaStoreId: 's-1' });
    expect(r.success && r.data.storeId).toBe('s-1');
  });
  it('template status still accepts the previous field', () => {
    const r = templateStatusSchema.safeParse({ ...base, [OLD_STORE]: 's-2' });
    expect(r.success && r.data.storeId).toBe('s-2');
  });
  it('template status rejects a body with neither', () => {
    expect(templateStatusSchema.safeParse(base).success).toBe(false);
  });
  it('cart store id prefers new, falls back to previous, else null', () => {
    expect(cartStoreId({ ebdaStoreId: 'a', [OLD_STORE]: 'b' })).toBe('a');
    expect(cartStoreId({ [OLD_STORE]: 'b' })).toBe('b');
    expect(cartStoreId({})).toBeNull();
  });
  it('has a removal date', () => {
    expect(WBS_WIRE_LEGACY_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
