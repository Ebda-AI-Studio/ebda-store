/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { accessToken, authState } from './helpers';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';

// HTTP half of tests/integration/customer-reorder.test.ts on the built Worker + StoreDO: GET /public/customers/me/reorder answers a signed-in
// customer `private, no-store` with Vary: Authorization, anonymous is 401, an admin token is 403, and a customer token is bound to ONE store
// (F-01): minted for store A it is dead on store B. The query semantics (last three paid or delivered orders, newest first, <= 12, on sale,
// per customer and store) run on the StoreDO schema in tests/unit/customer-reorder-do.test.ts.
let A: Merchant;
let B: Merchant;
const customerId = crypto.randomUUID();
const reorder = (m: Merchant, token?: string) =>
  call('/public/customers/me/reorder', { token, headers: { 'x-store-id': m.storeId } });
const customerToken = async (userId: string, storeId: string) => {
  await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '0', {}]]);
  return accessToken({ userId, jti: `j-${userId}`, role: 'customer', storeId });
};

describe('customer reorder route on the Worker (Ruling B4-8)', () => {
  beforeAll(async () => {
    A = await bootstrapMerchant('ro-a');
    B = await bootstrapMerchant('ro-b');
  }, 120_000);

  it('a signed-in customer gets the ids, private and uncacheable', async () => {
    const res = await reorder(A, await customerToken(customerId, A.storeId));
    expect(res.status, res.text).toBe(200);
    expect(res.json.data.productIds).toEqual([]);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(String(res.headers.get('vary'))).toMatch(/Authorization/i);
  });

  it('a token minted for store A is dead on store B; one bound to B reads only B', async () => {
    expect((await reorder(B, await customerToken(customerId, A.storeId))).status).toBe(401);
    const elsewhere = await reorder(B, await customerToken(customerId, B.storeId));
    expect(elsewhere.status, elsewhere.text).toBe(200);
    expect(elsewhere.json.data.productIds).toEqual([]);
  });

  it('anonymous is 401 and an admin token is 403', async () => {
    expect((await reorder(A)).status).toBe(401);
    expect((await reorder(A, A.token)).status).toBe(403);
  });
});
