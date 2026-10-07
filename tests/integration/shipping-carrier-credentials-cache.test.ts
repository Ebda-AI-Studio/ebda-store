/**
 * S2-1 (2026-09-22 security audit): `getCarrierConfigs` decrypted carrier
 * credentials (Aramex/iCarry API keys) BEFORE caching them in Redis, so for
 * the full 300s TTL the plaintext secret sat in the cache tier — the same
 * tier that had a public, unauthenticated TCP proxy exposed to the internet
 * until 2026-09-04 (removed, but "was recently exposed" is exactly the
 * threat model a defense-in-depth fix like this one is for).
 *
 * The fix caches the row AS FETCHED FROM PRISMA (still AES-256-GCM
 * encrypted) and decrypts only after every read, cache hit or miss. This
 * test writes a real carrier config through the same encrypted write path
 * production uses (`upsertCarrierConfig`), calls `getCarrierConfigs` (a
 * cache miss, so it also exercises the write side of the cache), and reads
 * the RAW Redis value back with the redis client directly — proving the
 * plaintext credential is not present in what Redis actually stores, while
 * the service's own return value is still correctly decrypted for callers.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { redis } from '../../apps/api/src/services/redis.service';
import { shippingCarrierService } from '../../apps/api/src/services/shipping-carrier.service';
import { decryptCarrierBlob } from '../../apps/api/src/services/carriers/carrier-credentials';
import { ARAMEX_STUB } from '../stubs/aramex-stub';

// redis.service prefixes every key with `cache:` on top of the service's own
// prefix — the actual Redis key is `cache:shipping:carrier-configs:v3:<id>`.
// The `:v3:` segment must track CARRIER_CONFIG_CACHE_PREFIX in the service: if
// it drifts, every assertion here reads a key nothing writes, finds null, and
// this suite passes while testing nothing.
const CACHE_KEY_PREFIX = 'cache:shipping:carrier-configs:v3:';

let storeId: string;
let userId: string;
let PLAINTEXT_SECRET: string;
const made: Array<{ storeId: string; userId: string }> = [];

// Per-CALL unique suffix, not per-file (vitest.config.ts sets `retry: 1`,
// which re-runs this exact test body against the SAME database — a
// module-level suffix would collide with attempt 1's still-uncommitted rows
// on the retry and mask the real failure behind a unique-constraint error).
async function setup() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  PLAINTEXT_SECRET = `super-secret-aramex-pw-${suffix}`;
  const user = await prisma.user.create({
    data: {
      email: `carrier-cache-${suffix}@example.test`,
      passwordHash: 'x',
      firstName: 'Carrier',
      lastName: 'Cache',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = user.id;

  const store = await prisma.store.create({
    data: {
      name: 'Carrier Cache Test Store',
      slug: `carrier-cache-${suffix}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
    },
  });
  storeId = store.id;
  made.push({ storeId, userId });
}

async function teardown() {
  await redis.connect();
  const c = redis.getClient();
  for (const m of made) {
    await prisma.shippingCarrierConfig.deleteMany({ where: { storeId: m.storeId } });
    await prisma.store.deleteMany({ where: { id: m.storeId } });
    await prisma.user.deleteMany({ where: { id: m.userId } });
    if (c) await c.del(`${CACHE_KEY_PREFIX}${m.storeId}`);
  }
}

describe('S2-1: shipping carrier credentials are never cached in plaintext', () => {
  afterAll(teardown);

  it('the Redis-cached value does not contain the plaintext credential', async () => {
    // Establish the Redis connection FIRST — a cold-start connect racing the
    // service's own lazy `getConnectedClient()` call below is a false-null
    // read, not evidence about the fix.
    await redis.connect();
    await setup();

    // Real write path — the connect flow's save (catalog fields of one mode, encrypted into one
    // blob). This also invalidates any stale cache entry.
    await shippingCarrierService.upsertCarrierConfig(storeId, 'aramex', {
      credentials: {
        mode: 'sandbox',
        fields: { ...ARAMEX_STUB.credentials, password: PLAINTEXT_SECRET },
      },
      activate: true,
    });

    // First call — cache MISS, so this also exercises the cache WRITE.
    const configs = await shippingCarrierService.getCarrierConfigs(storeId);
    expect(configs).toHaveLength(1);
    // The service's own return value is decrypted for its caller.
    // (the ACTIVE mode's flat field map, which is what an adapter takes)
    expect(configs[0].credentials.password).toBe(PLAINTEXT_SECRET);
    expect(configs[0].credentials.username).toBe(ARAMEX_STUB.credentials.username);

    // Read the RAW value Redis actually stores — bypassing the service.
    await redis.connect();
    const client = redis.getClient();
    expect(client).not.toBeNull();
    const raw = await client!.get(`${CACHE_KEY_PREFIX}${storeId}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(PLAINTEXT_SECRET);

    // The cached row's `credentials` field is still the encrypted blob —
    // not the decrypted object the service returns to its caller.
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(typeof parsed[0].credentials).toBe('string');
    expect(parsed[0].credentials).not.toContain(PLAINTEXT_SECRET);
    expect(parsed[0].credentials).not.toContain(ARAMEX_STUB.credentials.username);
    // ...and it is the ciphertext of the {sandbox, live, webhookSecret} blob, not a decrypted map
    expect(decryptCarrierBlob(parsed[0].credentials).sandbox?.password).toBe(PLAINTEXT_SECRET);
    // The hints column rides in the cached row too: a last-4 hint, never the secret
    expect(raw).not.toContain(PLAINTEXT_SECRET);
    expect(parsed[0].credentialHints.sandbox.password).toEqual({
      set: true,
      last4: PLAINTEXT_SECRET.slice(-4),
    });

    // Second call — cache HIT. Still returns the correctly decrypted value,
    // proving the fix decrypts on every read, not only the miss path.
    const cached = await shippingCarrierService.getCarrierConfigs(storeId);
    expect(cached[0].credentials.password).toBe(PLAINTEXT_SECRET);

    // The browser's view of the same cached row: hints only, no `credentials` key at all.
    const pub = await shippingCarrierService.getPublicCarrierConfigs(storeId);
    expect(pub).toHaveLength(1);
    expect(pub[0]).not.toHaveProperty('credentials');
    expect(JSON.stringify(pub)).not.toContain(PLAINTEXT_SECRET);
    expect(JSON.stringify(pub)).not.toContain(parsed[0].credentials);
  });

  it('a save drops the cached rows, so the next read is the new secret (no stale key for 300s)', async () => {
    await redis.connect();
    await setup();
    const fields = { ...ARAMEX_STUB.credentials, password: PLAINTEXT_SECRET };
    await shippingCarrierService.upsertCarrierConfig(storeId, 'aramex', {
      credentials: { mode: 'sandbox', fields },
      activate: true,
    });
    expect((await shippingCarrierService.getCarrierConfigs(storeId))[0].credentials.password).toBe(
      PLAINTEXT_SECRET
    );
    const client = redis.getClient()!;
    expect(await client.get(`${CACHE_KEY_PREFIX}${storeId}`)).not.toBeNull();

    const rotated = `${PLAINTEXT_SECRET}-rotated`;
    await shippingCarrierService.upsertCarrierConfig(storeId, 'aramex', {
      credentials: { mode: 'sandbox', fields: { password: rotated } },
    });
    expect(await client.get(`${CACHE_KEY_PREFIX}${storeId}`)).toBeNull();
    const next = await shippingCarrierService.getCarrierConfigs(storeId);
    expect(next[0].credentials.password).toBe(rotated);
    expect(await client.get(`${CACHE_KEY_PREFIX}${storeId}`)).not.toContain(rotated);
  });
});
