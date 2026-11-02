/**
 * Regression for #1865: preserveMaskedCredentials() threw a plain Error for
 * an unresolvable masked credential — errorHandler.ts's terminal branch
 * turns a non-AppError into a generic 500 "Internal server error" instead
 * of the actionable 400 the same guard in shipping-carrier.service.ts
 * already raises as an AppError.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, redisMock, encryptionMock } = vi.hoisted(() => ({
  mockPrisma: {
    notificationConfig: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
  },
  redisMock: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  encryptionMock: {
    encrypt: vi.fn((v: string) => `enc:${v}`),
    decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  withRlsBypass: (fn: (tx: unknown) => unknown) => fn(mockPrisma),
}));

vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: 'pg', db: mockPrisma }),
  storeWriter: async () => mockPrisma,
}));
vi.mock('@api/services/redis.service', () => ({ redis: redisMock }));
vi.mock('@api/services/encryption.service', () => ({ encryption: encryptionMock }));
vi.mock('@api/services/sms.service', () => ({ smsService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { notificationConfigService } from '@api/services/notification-config.service';
import { AppError } from '@api/middleware/error-handler';

beforeEach(() => vi.clearAllMocks());

describe('preserveMaskedCredentials — unresolvable masked credential (#1865)', () => {
  it('throws an AppError(400, NOTIFICATION_CREDENTIALS_UNRESOLVED), not a plain Error', async () => {
    // No stored row at all — the masked value has nothing to resolve against.
    mockPrisma.notificationConfig.findFirst.mockResolvedValue(null);

    const call = notificationConfigService.upsertConfig('store-1', 'sms', {
      provider: 'unifonic',
      credentials: { appSid: '****1234' },
      enabled: true,
    });

    await expect(call).rejects.toBeInstanceOf(AppError);
    await expect(call).rejects.toMatchObject({
      statusCode: 400,
      code: 'NOTIFICATION_CREDENTIALS_UNRESOLVED',
    });
  });
});
