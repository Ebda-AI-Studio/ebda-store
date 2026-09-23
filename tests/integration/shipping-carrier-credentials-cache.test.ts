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

// redis.service prefixes every key with `cache:` on top of the service's own
// prefix — the actual Redis key is `cache:shipping:carrier-configs:v2:<id>`.
// The `:v2:` segment must track CARRIER_CONFIG_CACHE_PREFIX in the service: if
// it drifts, every assertion here reads a key nothing writes, finds null, and
// this suite passes while testing nothing.
const CACHE_KEY_PREFIX = 'cache:shipping:carrier-configs:v2:';

let storeId: string;
let userId: string;
let PLAINTEXT_API_KEY: string;

// Per-CALL unique suffix, not per-file (vitest.config.ts sets `retry: 1`,
// which re-runs this exact test body against the SAME database — a
// module-level suffix would collide with attempt 1's still-uncommitted rows
// on the retry and mask the real failure behind a unique-constraint error).
async function setup() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  PLAINTEXT_API_KEY = `super-secret-aramex-key-${suffix}`;
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
}

async function teardown() {
  await prisma.shippingCarrierConfig.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await redis.connect();
  const c = redis.getClient();
  if (c) await c.del(`${CACHE_KEY_PREFIX}${storeId}`);
}

describe('S2-1: shipping carrier credentials are never cached in plaintext', () => {
  afterAll(teardown);

  it('the Redis-cached value does not contain the plaintext credential', async () => {
    // Establish the Redis connection FIRST — a cold-start connect racing the
    // service's own lazy `getConnectedClient()` call below is a false-null
    // read, not evidence about the fix.
    await redis.connect();
    await setup();

    // Real write path — same encryption `upsertCarrierConfig` production
    // routes use. This also invalidates any stale cache entry.
    await shippingCarrierService.upsertCarrierConfig(storeId, 'aramex', {
      enabled: true,
      credentials: { apiKey: PLAINTEXT_API_KEY, username: 'aramex-user' },
    });

    // First call — cache MISS, so this also exercises the cache WRITE.
    const configs = await shippingCarrierService.getCarrierConfigs(storeId);
    expect(configs).toHaveLength(1);
    // The service's own return value is decrypted for its caller.
    expect(configs[0].credentials.apiKey).toBe(PLAINTEXT_API_KEY);

    // Read the RAW value Redis actually stores — bypassing the service.
    await redis.connect();
    const client = redis.getClient();
    expect(client).not.toBeNull();
    const raw = await client!.get(`${CACHE_KEY_PREFIX}${storeId}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(PLAINTEXT_API_KEY);

    // The cached row's `credentials` field is still the encrypted blob —
    // not the decrypted object the service returns to its caller.
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(typeof parsed[0].credentials).toBe('string');
    expect(parsed[0].credentials).not.toContain(PLAINTEXT_API_KEY);

    // Second call — cache HIT. Still returns the correctly decrypted value,
    // proving the fix decrypts on every read, not only the miss path.
    const cached = await shippingCarrierService.getCarrierConfigs(storeId);
    expect(cached[0].credentials.apiKey).toBe(PLAINTEXT_API_KEY);
  });
});
