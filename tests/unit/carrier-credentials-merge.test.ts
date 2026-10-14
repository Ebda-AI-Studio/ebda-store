/**
 * The merge that guards a merchant's carrier secret (write-only credentials, shipping batch).
 *
 * Why this file exists: the merge base used to be read through a 300s Redis cache. When the cached
 * VALUE shape changed (decrypted object -> encrypted string) without the KEY changing, the reader
 * was handed an object, threw, was caught, and returned `{}`: indistinguishable from "this merchant
 * has no credentials". Every masked field the merchant resubmitted unchanged then had no stored
 * counterpart and was silently DROPPED, and the truncated set was persisted over the real secret.
 * The merchant saw a successful save; the secret was gone.
 *
 * The properties pinned here are the links of that chain, on the catalog (per-mode blob) design:
 *   0. concurrent saves are serialised by a row lock taken BEFORE the merge base is read,
 *   1. the merge base is read from Prisma, never from the cache,
 *   2. a masked echo of a secret keeps the stored one (nothing is overwritten with mask text),
 *   3. an UNREADABLE stored blob REFUSES the save instead of truncating it,
 *   4. a pre-v3 (already-decrypted) cached value fails loudly rather than reading as empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const findMany = vi.fn();
const queryRaw = vi.fn();
const update = vi.fn();

vi.mock('@ebda/database', () => {
  // Declared INSIDE the factory: vi.mock is hoisted above module-scope consts.
  const client: Record<string, unknown> = {
    shippingCarrierConfig: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      update: (...a: unknown[]) => update(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  };
  client.$transaction = (fn: (c: unknown) => unknown) => Promise.resolve(fn(client));
  client.$queryRaw = (...a: unknown[]) => queryRaw(...a);
  return {
    prisma: client,
    Prisma: {},
    withMoneyTx: (fn: (c: unknown) => unknown) => Promise.resolve(fn(client)),
    runInTenantContext: (_id: string, fn: () => unknown) => fn(),
    runInStoreScope: (_id: string, fn: () => unknown) => fn(),
  };
});

// The cache must not be consulted for a merge base: these spies are the proof.
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

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));

import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { decryptCarrierBlob, encryptCarrierBlob } from '@api/services/carriers/carrier-credentials';

const STORE = 'store_1';
const REAL = { username: 'ops@example.com', password: 'live-password-xyz' };

/** The stored row as Postgres holds it: credentials are an ENCRYPTED STRING. */
function storedRow(live: Record<string, string> = REAL) {
  return {
    id: 'cfg_1',
    carrier: 'mylerz',
    storeId: STORE,
    testMode: false,
    enabled: false,
    isDefault: false,
    settings: {},
    credentialHints: {},
    connectionTest: null,
    credentials: encryptCarrierBlob({ live }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
  update.mockResolvedValue({});
  upsert.mockImplementation(async (arg: { update: Record<string, unknown> }) => ({
    id: 'cfg_1',
    carrier: 'mylerz',
    ...arg.update,
  }));
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue(undefined);
  redisDelete.mockResolvedValue(undefined);
});

/** The live credentials actually handed to Prisma on the last upsert. */
function persistedLive(): Record<string, string> | undefined {
  const arg = upsert.mock.calls[0]?.[0] as { update: { credentials: string } };
  return decryptCarrierBlob(arg.update.credentials).live;
}

describe('concurrent saves cannot revert each other', () => {
  it('locks the carrier row (FOR UPDATE) before it reads the merge base, on save and on rotate', async () => {
    findUnique.mockResolvedValue(storedRow());
    const order: string[] = [];
    queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      order.push(`lock:${strings.join('?').includes('FOR UPDATE')}`);
      return [];
    });
    findUnique.mockImplementation(async () => {
      order.push('read');
      return storedRow();
    });
    await shippingCarrierService.upsertCarrierConfig(STORE, 'mylerz', {
      credentials: { mode: 'live', fields: { warehouseName: 'Maadi' } },
    });
    expect(order.slice(0, 2)).toEqual(['lock:true', 'read']);

    order.length = 0;
    findUnique.mockImplementation(async () => {
      order.push('read');
      return storedRow();
    });
    await shippingCarrierService.rotateWebhookSecret(STORE, 'mylerz');
    expect(order.slice(0, 2)).toEqual(['lock:true', 'read']);
  });

  it('a settings-only save of a legacy sandbox row re-shapes the blob so its keys do not become the LIVE set', async () => {
    const flat = encryptCarrierBlob({ live: REAL }); // placeholder shape replaced below
    void flat;
    const { encryption } = await import('@api/services/encryption.service');
    findUnique.mockResolvedValue({
      ...storedRow(),
      testMode: true,
      settings: { sandbox: true, pickupName: 'X' },
      credentials: encryption.encrypt(JSON.stringify({ username: 'sbx-user', password: 'sbx-pw' })),
    });
    await shippingCarrierService.upsertCarrierConfig(STORE, 'mylerz', {
      settings: { pickupName: 'Y', sandbox: true },
    });
    const arg = upsert.mock.calls[0]?.[0] as { update: { credentials: string; settings: object } };
    const blob = decryptCarrierBlob(arg.update.credentials);
    expect(blob.sandbox).toEqual({ username: 'sbx-user', password: 'sbx-pw' });
    expect(blob.live).toBeUndefined();
    expect(arg.update.settings).toEqual({ pickupName: 'Y' });
  });
});

describe('a masked resubmit must never erase a secret', () => {
  it('keeps the stored secret when the merchant resubmits a mask untouched', async () => {
    findUnique.mockResolvedValue(storedRow());

    await shippingCarrierService.upsertCarrierConfig(STORE, 'mylerz', {
      credentials: {
        mode: 'live',
        fields: { username: 'ops@example.com', password: '****xyz', warehouseName: 'Maadi' },
      },
    });

    expect(persistedLive()).toEqual({ ...REAL, warehouseName: 'Maadi' });
  });

  it('reads the merge base from Prisma, never from the Redis cache', async () => {
    findUnique.mockResolvedValue(storedRow());

    await shippingCarrierService.upsertCarrierConfig(STORE, 'mylerz', {
      credentials: { mode: 'live', fields: { warehouseName: 'Maadi' } },
    });

    // A cached base is stale by up to the TTL and silently reverts a credential changed moments
    // ago on another replica.
    expect(findUnique).toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('takes a newly typed credential over the stored one and leaves the other mode alone', async () => {
    const row = storedRow();
    row.credentials = encryptCarrierBlob({
      live: REAL,
      sandbox: { username: 'sbx', password: 'sbx-pw' },
    });
    findUnique.mockResolvedValue(row);

    await shippingCarrierService.upsertCarrierConfig(STORE, 'mylerz', {
      credentials: { mode: 'live', fields: { password: 'brand-new-password' } },
    });

    expect(persistedLive()).toEqual({ ...REAL, password: 'brand-new-password' });
    const arg = upsert.mock.calls[0]?.[0] as { update: { credentials: string } };
    expect(decryptCarrierBlob(arg.update.credentials).sandbox).toEqual({
      username: 'sbx',
      password: 'sbx-pw',
    });
  });

  /** THE regression: an unreadable base must stop the save, not be merged over. */
  it('refuses the save rather than truncating when the stored row cannot be decrypted', async () => {
    findUnique.mockResolvedValue({ ...storedRow(), credentials: 'not-a-valid-ciphertext' });

    await expect(
      shippingCarrierService.upsertCarrierConfig(STORE, 'mylerz', {
        credentials: { mode: 'live', fields: { warehouseName: 'Maadi' } },
      })
    ).rejects.toMatchObject({ code: 'CARRIER_CREDENTIALS_UNRESOLVED', statusCode: 400 });
    // Refusing is only safe if nothing was written.
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('a pre-v3 cache shape fails loudly, not as "empty"', () => {
  it('throws instead of returning {} when credentials are an already-decrypted object', async () => {
    // Exactly what a surviving old Redis entry looks like: `credentials` is the decrypted OBJECT,
    // not the encrypted string. Returning {} here is what made carrier auth fail on live orders
    // and fed the erasing merge.
    redisGet.mockResolvedValue([
      { carrier: 'mylerz', testMode: false, credentials: { username: 'plain' } },
    ]);

    await expect(shippingCarrierService.getCarrierConfigs(STORE)).rejects.toThrow(
      'not an encrypted string'
    );
  });

  it('still reports a genuinely unconfigured carrier as empty credentials', async () => {
    redisGet.mockResolvedValue([{ carrier: 'mylerz', testMode: false, credentials: '' }]);

    const configs = await shippingCarrierService.getCarrierConfigs(STORE);
    expect(configs[0].credentials).toEqual({});
  });

  it('the admin list never carries credentials, only hints', async () => {
    redisGet.mockResolvedValue([storedRow()]);

    const [view] = await shippingCarrierService.getPublicCarrierConfigs(STORE);
    expect(JSON.stringify(view)).not.toContain('live-password-xyz');
    expect(view.credentials).toBeUndefined();
  });
});
