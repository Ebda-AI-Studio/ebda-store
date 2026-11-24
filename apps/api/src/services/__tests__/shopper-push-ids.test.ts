import { describe, it, expect } from 'vitest';
import { shopperOneSignalPlayerIds } from '../shopper-push-ids';

// CLOSE-ACCOUNT-500: a StoreDO db has no oneSignalSubscription delegate; the read crashed every shopper closure with a 500.
describe('shopperOneSignalPlayerIds', () => {
  it('returns [] when the db has no oneSignalSubscription delegate (StoreDO db, a shopper with no wallet/orders)', async () => {
    await expect(shopperOneSignalPlayerIds({}, 'u1')).resolves.toEqual([]);
  });
  it('returns [] when the delegate lacks findMany', async () => {
    await expect(shopperOneSignalPlayerIds({ oneSignalSubscription: {} }, 'u1')).resolves.toEqual(
      []
    );
  });
  it('returns [] when the read rejects', async () => {
    const db = { oneSignalSubscription: { findMany: async () => Promise.reject(new Error('x')) } };
    await expect(shopperOneSignalPlayerIds(db, 'u1')).resolves.toEqual([]);
  });
  it('maps player ids when present', async () => {
    const db = {
      oneSignalSubscription: { findMany: async () => [{ playerId: 'a' }, { playerId: 'b' }] },
    };
    await expect(shopperOneSignalPlayerIds(db, 'u1')).resolves.toEqual(['a', 'b']);
  });
});
