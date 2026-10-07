/**
 * Credential + scope model for the MERCHANT-ADMIN MCP surface.
 *
 * This surface can change anything in a store — catalogue, orders, settings —
 * so the two properties under test here are the whole security boundary:
 *
 *   1. `verifyMerchantKey` accepts EXACTLY the keys that should work, and
 *      refuses everything else with a byte-identical 404;
 *   2. `assertScope` is what separates a reporting key from one that can
 *      delete a product.
 *
 * The case worth naming is CROSS-STORE. `keyHash` is globally unique, so the
 * lookup finds a valid, unrevoked, unexpired row for a key minted for another
 * store — every check except the tenant comparison passes. If that comparison
 * is ever dropped, a merchant can drive someone else's store with their own
 * legitimate key, and nothing else in the stack would notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const findUnique = vi.fn();
// The owning user's state comes from the `ebda_user_state` definer, not a join: the fake returns
// the `user` the stored-row fixture carries (null = no such user).
const userOf = vi.hoisted(() => ({ value: null as unknown }));
const getUserState = vi.hoisted(() => vi.fn());
const update = vi.fn().mockResolvedValue({});

vi.mock('@force/database', () => {
  // Declared INSIDE the factory: vi.mock is hoisted above module-scope consts,
  // so a `tx` defined outside would be undefined when this runs.
  const client = {
    merchantApiKey: {
      findUnique: async (...a: unknown[]) => {
        const row = (await findUnique(...a)) as { user?: unknown } | null;
        userOf.value = row?.user ?? null;
        return row;
      },
      update: (...a: unknown[]) => update(...a),
    },
  };
  return {
    prisma: client,
    // `verifyMerchantKey` runs inside the store's own scope: the store is already resolved by
    // slug, and the key lookup is by hash within that store (strict RLS hides other stores' keys).
    withStore: (_storeId: string, fn: (c: unknown) => unknown) => Promise.resolve(fn(client)),
  };
});

vi.mock('@api/lib/definer', () => ({
  getUserState: (...a: unknown[]) => getUserState(...a),
}));

vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  verifyMerchantKey,
  assertScope,
  hashMerchantKey,
  generateMerchantKey,
  MERCHANT_SCOPES,
  MERCHANT_KEY_PREFIX,
  ALL_MERCHANT_SCOPES,
} from '@api/mcp/merchant-auth';

const STORE = { id: 'store-1', name: 'Demo', slug: 'demo', currency: 'EGP', domain: null };
const OTHER_STORE_ID = 'store-2';

function reqWithKey(key?: string): Request {
  return {
    get: (h: string) => (h.toLowerCase() === 'x-merchant-key' ? key : undefined),
    ip: '203.0.113.9',
  } as unknown as Request;
}

/** A stored row that is valid in every respect, for targeted mutation per test. */
function validRow(plaintext: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    storeId: STORE.id,
    userId: 'user-1',
    keyHash: hashMerchantKey(plaintext),
    scopes: [MERCHANT_SCOPES.read],
    revokedAt: null,
    expiresAt: null,
    user: { status: 'active', deletedAt: null },
    ...overrides,
  };
}

describe('generateMerchantKey', () => {
  it('mints a prefixed, high-entropy key whose hash matches', () => {
    const { plaintext, hash, prefix } = generateMerchantKey();
    expect(plaintext.startsWith(MERCHANT_KEY_PREFIX)).toBe(true);
    expect(hash).toBe(hashMerchantKey(plaintext));
    expect(prefix).toBe(plaintext.slice(0, MERCHANT_KEY_PREFIX.length + 8));
    // 32 random bytes base64url ≈ 43 chars, plus the prefix.
    expect(plaintext.length).toBeGreaterThan(40);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateMerchantKey().plaintext));
    expect(keys.size).toBe(200);
  });

  it('does not put the plaintext in the prefix beyond 8 chars', () => {
    const { plaintext, prefix } = generateMerchantKey();
    expect(prefix.length).toBeLessThan(plaintext.length);
  });
});

describe('verifyMerchantKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserState.mockImplementation(async () => userOf.value);
    update.mockResolvedValue({});
  });

  it('accepts a valid key and returns the acting user + scopes', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext, { scopes: ALL_MERCHANT_SCOPES }));

    const auth = await verifyMerchantKey(reqWithKey(plaintext), STORE);

    expect(auth.keyId).toBe('key-1');
    expect(auth.userId).toBe('user-1');
    expect(auth.storeId).toBe(STORE.id);
    expect(auth.scopes).toEqual([...ALL_MERCHANT_SCOPES]);
  });

  it('never returns the plaintext or the full hash — only a fingerprint', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext));

    const auth = await verifyMerchantKey(reqWithKey(plaintext), STORE);

    const serialized = JSON.stringify(auth);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(hashMerchantKey(plaintext));
    expect(auth.token).toHaveLength(12);
  });

  it('looks the key up by HASH, never by a scan of every row', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext));
    await verifyMerchantKey(reqWithKey(plaintext), STORE);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: hashMerchantKey(plaintext), storeId: STORE.id } })
    );
  });

  it('REFUSES a valid key minted for another store', async () => {
    const { plaintext } = generateMerchantKey();
    // Every other property is valid — this is the tenant check alone.
    findUnique.mockResolvedValue(validRow(plaintext, { storeId: OTHER_STORE_ID }));
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses a revoked key', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext, { revokedAt: new Date('2026-01-01') }));
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses an expired key', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext, { expiresAt: new Date(Date.now() - 60_000) }));
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('accepts a key whose expiry is still in the future', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(
      validRow(plaintext, { expiresAt: new Date(Date.now() + 86_400_000) })
    );
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).resolves.toMatchObject({
      keyId: 'key-1',
    });
  });

  it('refuses an unknown key', async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      verifyMerchantKey(reqWithKey(`${MERCHANT_KEY_PREFIX}totally-made-up-value`), STORE)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a missing header without touching the database', async () => {
    await expect(verifyMerchantKey(reqWithKey(undefined), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses a too-short header without touching the database', async () => {
    await expect(verifyMerchantKey(reqWithKey('ebdam_'), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('gives every refusal a byte-identical body — no oracle over which check failed', async () => {
    const { plaintext } = generateMerchantKey();
    const cases = [
      () => findUnique.mockResolvedValue(null),
      () => findUnique.mockResolvedValue(validRow(plaintext, { storeId: OTHER_STORE_ID })),
      () => findUnique.mockResolvedValue(validRow(plaintext, { revokedAt: new Date() })),
      () => findUnique.mockResolvedValue(validRow(plaintext, { expiresAt: new Date(0) })),
      () =>
        findUnique.mockResolvedValue(
          validRow(plaintext, { user: { status: 'suspended', deletedAt: null } })
        ),
    ];
    const bodies: string[] = [];
    for (const setup of cases) {
      vi.clearAllMocks();
      setup();
      await verifyMerchantKey(reqWithKey(plaintext), STORE).catch((e: any) =>
        bodies.push(JSON.stringify({ status: e.statusCode, code: e.code, message: e.message }))
      );
    }
    expect(bodies).toHaveLength(5);
    expect(new Set(bodies).size).toBe(1);
  });

  it("REFUSES a suspended user's key — the dashboard lever must reach the device", async () => {
    // A key is a device acting AS a person. Suspending the person has to stop
    // the device, or the platform's strongest lever is a partial one.
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(
      validRow(plaintext, { user: { status: 'suspended', deletedAt: null } })
    );
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("REFUSES a soft-deleted user's key", async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(
      validRow(plaintext, { user: { status: 'active', deletedAt: new Date('2026-01-01') } })
    );
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses when the owning user row is missing entirely', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext, { user: null }));
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('reads the owning user on EVERY verification, not just at mint', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext));
    await verifyMerchantKey(reqWithKey(plaintext), STORE);
    // the key row names its owner, and that owner's CURRENT state is read (definer) every time
    expect(getUserState).toHaveBeenCalledWith('user-1');
    await verifyMerchantKey(reqWithKey(plaintext), STORE);
    expect(getUserState).toHaveBeenCalledTimes(2);
  });

  it('stamps lastUsedAt without letting a failed stamp fail the request', async () => {
    const { plaintext } = generateMerchantKey();
    findUnique.mockResolvedValue(validRow(plaintext));
    update.mockRejectedValue(new Error('db down'));
    await expect(verifyMerchantKey(reqWithKey(plaintext), STORE)).resolves.toMatchObject({
      keyId: 'key-1',
    });
  });
});

describe('assertScope', () => {
  const auth = (scopes: string[]) => ({ scopes, keyId: 'k', userId: 'u', storeId: 's' });

  it('passes when the key carries the required scope', () => {
    expect(() =>
      assertScope(auth([MERCHANT_SCOPES.read]), MERCHANT_SCOPES.read, 't')
    ).not.toThrow();
  });

  it('refuses a read-only key a write operation', () => {
    expect(() =>
      assertScope(auth([MERCHANT_SCOPES.read]), MERCHANT_SCOPES.write, 'admin_x')
    ).toThrow(/FORBIDDEN: admin_x requires the "merchant:write" scope/);
  });

  it('refuses a write key a destructive operation — write does not imply destructive', () => {
    expect(() =>
      assertScope(auth([MERCHANT_SCOPES.write]), MERCHANT_SCOPES.destructive, 'admin_delete')
    ).toThrow(/FORBIDDEN/);
  });

  it('refuses an empty scope list', () => {
    expect(() => assertScope(auth([]), MERCHANT_SCOPES.read, 't')).toThrow(/FORBIDDEN/);
  });

  it('refuses undefined auth — an unauthenticated call must never reach a tool', () => {
    expect(() => assertScope(undefined, MERCHANT_SCOPES.read, 't')).toThrow(/FORBIDDEN/);
  });

  it('refuses a forged scopes value that is not an array', () => {
    expect(() =>
      assertScope({ scopes: 'merchant:destructive' }, MERCHANT_SCOPES.destructive, 't')
    ).toThrow(/FORBIDDEN/);
  });

  it('names the scopes the key actually has, to make the failure actionable', () => {
    expect(() => assertScope(auth([MERCHANT_SCOPES.read]), MERCHANT_SCOPES.write, 't')).toThrow(
      /\[merchant:read\]/
    );
  });
});
