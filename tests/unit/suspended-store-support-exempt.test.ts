/**
 * #804 x #674: a suspended store is read-only for its merchant, but the way OUT of a suspension stays open: the
 * suspension appeal and a support request are never refused by the read-only gate, whatever the suspension. Every other
 * write still is. Mutation: drop the `isStoreSupportRoute` early return in `suspendedWriteBlock` -> the first test reddens.
 */
import { describe, it, expect } from 'vitest';
import { isStoreSupportRoute, suspendedWriteBlock } from '@api/middleware/store-access';

const S = '/api/v1/stores/11111111-1111-4111-8111-111111111111';
const platform = { status: 'suspended', billingSuspendedReason: null };
const billing = { status: 'suspended', billingSuspendedReason: 'unpaid' };

describe('a suspended store can always ask for its way back', () => {
  it('the appeal and a support request pass the read-only gate on a platform and a billing suspension', () => {
    for (const store of [platform, billing])
      for (const p of [`${S}/suspension/appeal`, `${S}/support-requests`])
        expect(suspendedWriteBlock(store, 'store_admin', 'POST', p), p).toBeNull();
  });
  it('every other write is still refused 403 STORE_SUSPENDED', () => {
    const block = suspendedWriteBlock(platform, 'store_admin', 'POST', `${S}/products`);
    expect(block?.statusCode).toBe(403);
    expect(block?.code).toBe('STORE_SUSPENDED');
    expect(
      suspendedWriteBlock(platform, 'store_admin', 'PUT', `${S}/suspension/appeal`)?.code
    ).toBe('STORE_SUSPENDED');
  });
  it('the match is anchored: a lookalike path is not the support route', () => {
    expect(isStoreSupportRoute('POST', `${S}/products/suspension/appeal`)).toBe(false);
    expect(isStoreSupportRoute('POST', `${S}/support-requests/x`)).toBe(false);
    expect(isStoreSupportRoute('GET', `${S}/support-requests`)).toBe(false);
  });
});
