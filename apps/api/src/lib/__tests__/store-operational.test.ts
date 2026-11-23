/**
 * Ruling SUSPEND-OUT-1 / QA-81: now that a super-admin can suspend from the UI, pin what a suspended store refuses.
 * Only `active` may message customers or move money out; a suspended or inactive store, an unknown one and a failed
 * status lookup all refuse (customer sends fail CLOSED, money-out throws 423 STORE_NOT_OPERATIONAL).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupStore = vi.fn();
vi.mock('../definer', () => ({ lookupStore: (...a: unknown[]) => lookupStore(...a) }));
vi.mock('@ebda/database', () => ({ storeDirectory: vi.fn() }));
vi.mock('../logger', () => ({ default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import {
  assertStoreOperational,
  isStoreOperational,
  storeMayMessageCustomers,
} from '../store-operational';

beforeEach(() => lookupStore.mockReset());

describe('store operational gate', () => {
  it('only an active store is operational', () => {
    expect(isStoreOperational('active')).toBe(true);
    for (const s of ['suspended', 'inactive', '', null, undefined]) {
      expect(isStoreOperational(s as string | null | undefined)).toBe(false);
    }
  });

  it('money-out (assert) refuses a suspended store with 423 and EN + AR copy, and passes an active one', async () => {
    lookupStore.mockResolvedValue({ id: 's1', status: 'suspended' });
    await expect(assertStoreOperational('s1')).rejects.toMatchObject({
      statusCode: 423,
      code: 'STORE_NOT_OPERATIONAL',
      details: { messageEn: expect.any(String), messageAr: expect.any(String) },
    });
    lookupStore.mockResolvedValue({ id: 's1', status: 'active' });
    await expect(assertStoreOperational('s1')).resolves.toBeUndefined();
  });

  it('customer sends skip a suspended store, an unknown one and a failed lookup (fail closed)', async () => {
    lookupStore.mockResolvedValue({ id: 's1', status: 'suspended' });
    expect(await storeMayMessageCustomers('s1', 'test')).toBe(false);
    lookupStore.mockResolvedValue(null);
    expect(await storeMayMessageCustomers('s1', 'test')).toBe(false);
    lookupStore.mockRejectedValue(new Error('d1 down'));
    expect(await storeMayMessageCustomers('s1', 'test')).toBe(false);
    lookupStore.mockResolvedValue({ id: 's1', status: 'active' });
    expect(await storeMayMessageCustomers('s1', 'test')).toBe(true);
  });
});
