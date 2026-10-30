/**
 * notification-config preserveMaskedCredentials — the SIBLING of the carrier
 * merge bug, fixed in the same pass.
 *
 * The shipping-carrier service lost a merchant's Aramex/iCarry secret because
 * its masked-resubmit merge read its base through a 300s Redis cache and, when
 * that base came back empty, silently DROPPED the masked field and persisted
 * the truncated set. This service had the identical shape — merge base via
 * `getConfig` (cached), and the same "if none exists, drop the field" branch —
 * against provider secrets like the Unifonic appSid. A defect found once is a
 * sample of its class, so both are pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();
const findMany = vi.fn();

vi.mock('@ebda/database', () => {
  const client = {
    notificationConfig: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findFirst: (...a: unknown[]) => findUnique(...a), // the repo read (storeRepo) is a findFirst on the same row
      upsert: (...a: unknown[]) => upsert(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  };
  return {
    prisma: client,
    withStore: (_id: string, fn: (c: unknown) => unknown) => Promise.resolve(fn(client)),
  };
});

vi.mock('@api/lib/repo-factory', async () => {
  const { prisma } = await import('@ebda/database');
  return {
    storeRepo: async () => ({ backend: 'pg', db: prisma }),
    storeWriter: async () => prisma,
  };
});

const redisGet = vi.fn();
vi.mock('@api/services/redis.service', () => ({
  redis: {
    get: (...a: unknown[]) => redisGet(...a),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

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

vi.mock('@api/services/sms.service', () => ({ smsService: { send: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { notificationConfigService } from '@api/services/notification-config.service';

const STORE = 'store_1';
const REAL = { appSid: 'live-app-sid', senderId: 'FORCE' };

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({
    channel: 'sms',
    provider: 'unifonic',
    credentials: 'enc({})',
    enabled: true,
  });
  redisGet.mockResolvedValue(null);
  findMany.mockResolvedValue([]);
});

function persistedCredentials(): Record<string, unknown> {
  const arg = upsert.mock.calls[0]?.[0] as { update: { credentials: string } };
  return JSON.parse(/^enc\((.*)\)$/s.exec(arg.update.credentials)![1]);
}

describe('notification credentials merge — a masked resubmit must never erase a secret', () => {
  it('keeps the stored secret and reads its base from Prisma, not the cache', async () => {
    findUnique.mockResolvedValue({ credentials: `enc(${JSON.stringify(REAL)})` });

    await notificationConfigService.upsertConfig(STORE, 'sms', {
      provider: 'unifonic',
      enabled: true,
      credentials: { appSid: '****', senderId: 'FORCE' },
    });

    expect(persistedCredentials()).toEqual(REAL);
    expect(findUnique).toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('refuses the save when a masked field has no resolvable stored value', async () => {
    findUnique.mockResolvedValue({ credentials: `enc(${JSON.stringify({ senderId: 'FORCE' })})` });

    await expect(
      notificationConfigService.upsertConfig(STORE, 'sms', {
        provider: 'unifonic',
        enabled: true,
        credentials: { appSid: '****', senderId: 'FORCE' },
      })
      // #1865: an AppError now, same shape as the carrier sibling guard
      // (carrier-credentials-merge.test.ts) — the code lives on `.code`,
      // not embedded in the message string.
    ).rejects.toMatchObject({ code: 'NOTIFICATION_CREDENTIALS_UNRESOLVED', statusCode: 400 });

    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses the save rather than truncating when the stored row cannot be decrypted', async () => {
    findUnique.mockResolvedValue({ credentials: 'not-a-valid-ciphertext' });

    await expect(
      notificationConfigService.upsertConfig(STORE, 'sms', {
        provider: 'unifonic',
        enabled: true,
        credentials: { appSid: '****' },
      })
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });
});
