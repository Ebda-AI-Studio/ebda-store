/**
 * preserveMaskedCredentials — the masked-resubmit merge that guards a
 * merchant's carrier secret.
 *
 * Why this file exists: the merge base used to be read through
 * `getCarrierConfig`, i.e. through a 300s Redis cache. When the cached VALUE
 * shape changed (decrypted object → encrypted string) without the KEY
 * changing, `decryptCredentials` was handed an object, threw, was caught, and
 * returned `{}` — indistinguishable from "this merchant has no credentials".
 * Every masked field the merchant resubmitted unchanged then had no stored
 * counterpart and was silently DROPPED, and the truncated set was encrypted
 * and persisted over the real Aramex/iCarry secret. The merchant saw a
 * successful save; the secret was gone.
 *
 * The three properties pinned here are the three links of that chain:
 *   1. the merge base is read from Prisma, never from the cache,
 *   2. an unresolvable masked field REFUSES the save instead of dropping it,
 *   3. a pre-v2 (already-decrypted) credentials value fails loudly rather than
 *      reading as empty.
 * The existing integration suite only ever exercises a clean cache, so none of
 * these would go red there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();
const findMany = vi.fn();

vi.mock('@force/database', () => {
  // Declared INSIDE the factory: vi.mock is hoisted above module-scope consts.
  const client = {
    shippingCarrierConfig: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  };
  return {
    prisma: client,
    Prisma: {},
    withMoneyTx: (fn: (c: unknown) => unknown) => Promise.resolve(fn(client)),
  };
});

// The cache must not be consulted for a merge base — these spies are the proof.
const redisGet = vi.fn();
const redisSet = vi.fn();
const redisDelete = vi.fn();
vi.mock('@api/services/redis.service', () => ({
  redis: {
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
    delete: (...a: unknown[]) => redisDelete(...a),
  },
}));

// Reversible stand-ins: encrypt/decrypt round-trip so the test asserts on the
// MERGE, not on cryptography. decrypt throws on a non-string exactly as the
// real AES-GCM implementation does when handed an object.
vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    encrypt: (plain: string) => `enc(${plain})`,
    decrypt: (blob: unknown) => {
      if (typeof blob !== 'string') throw new TypeError('decrypt expects a string');
      const m = /^enc\((.*)\)$/s.exec(blob);
      if (!m) throw new Error('bad ciphertext');
      return m[1];
    },
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));

import { shippingCarrierService } from '@api/services/shipping-carrier.service';

const STORE = 'store_1';
const REAL = { apiKey: 'live-key-abc', password: 'live-password-xyz' };

/** The stored row as Postgres holds it: credentials are an ENCRYPTED STRING. */
function storedRow(creds: Record<string, string> = REAL) {
  return { credentials: `enc(${JSON.stringify(creds)})` };
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({ id: 'cfg_1' });
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue(undefined);
  redisDelete.mockResolvedValue(undefined);
});

/** The credentials actually handed to Prisma on the last upsert. */
function persistedCredentials(): Record<string, string> {
  const arg = upsert.mock.calls[0]?.[0] as { update: { credentials: string } };
  return JSON.parse(/^enc\((.*)\)$/s.exec(arg.update.credentials)![1]);
}

describe('preserveMaskedCredentials — a masked resubmit must never erase a secret', () => {
  it('keeps the stored secret when the merchant resubmits a mask untouched', async () => {
    findUnique.mockResolvedValue(storedRow());

    await shippingCarrierService.upsertCarrierConfig(STORE, 'aramex', {
      enabled: true,
      credentials: { apiKey: 'live****', password: '****' },
    });

    expect(persistedCredentials()).toEqual(REAL);
  });

  it('reads the merge base from Prisma, never from the Redis cache', async () => {
    findUnique.mockResolvedValue(storedRow());

    await shippingCarrierService.upsertCarrierConfig(STORE, 'aramex', {
      enabled: true,
      credentials: { apiKey: 'live****', password: '****' },
    });

    // A cached base is stale by up to the 300s TTL and silently reverts a
    // credential changed moments ago on another replica.
    expect(findUnique).toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('takes a newly typed credential over the stored one', async () => {
    findUnique.mockResolvedValue(storedRow());

    await shippingCarrierService.upsertCarrierConfig(STORE, 'aramex', {
      enabled: true,
      credentials: { apiKey: 'brand-new-key', password: '****' },
    });

    expect(persistedCredentials()).toEqual({
      apiKey: 'brand-new-key',
      password: REAL.password,
    });
  });

  /**
   * THE regression. Previously this dropped `password` and persisted
   * `{apiKey}` — a successful-looking save that destroyed the secret.
   */
  it('refuses the save when a masked field has no resolvable stored value', async () => {
    findUnique.mockResolvedValue(storedRow({ apiKey: 'live-key-abc' })); // no password stored

    await expect(
      shippingCarrierService.upsertCarrierConfig(STORE, 'aramex', {
        enabled: true,
        credentials: { apiKey: 'live****', password: '****' },
      })
    ).rejects.toMatchObject({ code: 'CARRIER_CREDENTIALS_UNRESOLVED', statusCode: 400 });

    // Refusing is only safe if nothing was written.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses the save rather than truncating when the stored row cannot be decrypted', async () => {
    findUnique.mockResolvedValue({ credentials: 'not-a-valid-ciphertext' });

    await expect(
      shippingCarrierService.upsertCarrierConfig(STORE, 'aramex', {
        enabled: true,
        credentials: { apiKey: 'live****' },
      })
    ).rejects.toMatchObject({ code: 'CARRIER_CREDENTIALS_UNRESOLVED', statusCode: 400 });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('decryptCredentials — a pre-v2 cache shape fails loudly, not as "empty"', () => {
  it('throws instead of returning {} when credentials are an already-decrypted object', async () => {
    // Exactly what a surviving pre-v2 Redis entry looks like: `credentials` is
    // the decrypted OBJECT, not the encrypted string. Returning {} here is what
    // made carrier auth fail on live orders and fed the erasing merge.
    redisGet.mockResolvedValue([{ carrier: 'aramex', credentials: { apiKey: 'plain' } }]);

    await expect(shippingCarrierService.getCarrierConfigs(STORE)).rejects.toThrow(
      'not an encrypted string'
    );
  });

  it('still reports a genuinely unconfigured carrier as empty credentials', async () => {
    redisGet.mockResolvedValue([{ carrier: 'aramex', credentials: null }]);

    const configs = await shippingCarrierService.getCarrierConfigs(STORE);
    expect(configs[0].credentials).toEqual({});
  });
});
