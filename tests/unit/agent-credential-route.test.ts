/**
 * Route-level tests for the agent (MCP) write credential admin API — the
 * surface the new `/stores/[id]/agent-key` merchant page wraps.
 *
 * Boots a minimal Express app mounting only `agent-credential.routes` with the
 * auth chain stubbed out, the same app-bootstrap pattern as
 * `tests/unit/coupon-validate-targeting-route.test.ts`. Only Prisma, the
 * encryption service and the feature service are mocked; the handlers run for
 * real.
 *
 * The properties under test are the point of the feature, not incidental:
 *
 *   1. The plaintext key leaves the server EXACTLY ONCE, in the 201 body of the
 *      mint/rotate POST, and no subsequent read can produce it. A "show it to me
 *      again" path would make the whole one-time-reveal design theatre.
 *   2. The GET status endpoint never returns the stored CIPHERTEXT either — the
 *      thing the parent PR had to `omit` at three StoreService boundaries after
 *      a wide read leaked it.
 *   3. Revoke actually clears the column. A revoke that only stamped
 *      `rotatedAt` would return `{ hasKey: false }` and read as successful in
 *      the UI while the old key kept authorising writes — the worst possible
 *      failure for a control whose entire job is to stop working.
 *   4. The escape-hatch state (`agent_checkout_open_writes`) is resolved
 *      server-side and reported honestly in both directions, including when the
 *      feature service throws (which must read as CLOSED, never open).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const { mockPrisma, mockIsFeatureEnabled, mockAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    store: { findUnique: vi.fn(), update: vi.fn() },
  },
  mockIsFeatureEnabled: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
  requireRecentLogin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/security', () => ({
  auditLog: mockAuditLog,
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: mockIsFeatureEnabled },
}));

// Reversible stand-in for AES-256-GCM so the test can prove the RESPONSE never
// contains the stored blob, without needing a real ENCRYPTION_KEY.
vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    encrypt: (v: string) => `CIPHERTEXT(${v})`,
    decrypt: (v: string) => String(v).replace(/^CIPHERTEXT\(|\)$/g, ''),
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── App bootstrap ──────────────────────────────────────────────────────────

let app: Express;
const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BASE = `/api/v1/stores/${STORE_ID}/integrations/agent-key`;

beforeAll(async () => {
  const { default: agentCredentialRouter } = await import('@api/routes/agent-credential.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores', agentCredentialRouter);
  server.use(errorHandler);
  app = server;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFeatureEnabled.mockResolvedValue(false);
  mockPrisma.store.update.mockResolvedValue({ id: STORE_ID });
});

describe('GET status — never the key, in any form', () => {
  it('reports hasKey without returning the stored ciphertext', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: { agentApiKey: 'CIPHERTEXT(fak_the_real_secret)' },
      agentApiKeyRotatedAt: new Date('2026-09-09T10:00:00.000Z'),
    });

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.data.hasKey).toBe(true);
    expect(res.body.data.header).toBe('x-agent-key');
    // The whole response body, not just the fields we thought to name.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('CIPHERTEXT');
    expect(raw).not.toContain('fak_');
    expect(res.body.data.apiKey).toBeUndefined();
    expect(res.body.data.agentApiKey).toBeUndefined();
  });

  it('reports hasKey=false and a null rotation stamp when no key was ever issued', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: null,
      agentApiKeyRotatedAt: null,
    });

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.data.hasKey).toBe(false);
    expect(res.body.data.rotatedAt).toBeNull();
  });

  it('404s a store that does not exist rather than answering for another one', async () => {
    mockPrisma.store.findUnique.mockResolvedValue(null);
    const res = await request(app).get(BASE);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('STORE_NOT_FOUND');
  });
});

describe('GET status — the escape hatch is reported honestly', () => {
  beforeEach(() => {
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: null,
      agentApiKeyRotatedAt: null,
    });
  });

  it('is false when the feature is off', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const res = await request(app).get(BASE);
    expect(res.body.data.openWrites).toBe(false);
  });

  it('is true when the feature is on for this store', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    const res = await request(app).get(BASE);
    expect(res.body.data.openWrites).toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(STORE_ID, 'agent_checkout_open_writes');
  });

  it('reads as CLOSED when the feature lookup fails — never optimistically open', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('redis down'));
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.data.openWrites).toBe(false);
  });
});

describe('POST mint/rotate — the plaintext leaves exactly once', () => {
  it('returns the plaintext key on mint and stores only the ciphertext', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({ credentials: null });

    const res = await request(app).post(BASE);

    expect(res.status).toBe(201);
    const key = res.body.data.apiKey as string;
    expect(key).toMatch(/^fak_[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.rotated).toBe(false);

    expect(mockPrisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STORE_ID },
        data: expect.objectContaining({
          credentials: {
            upsert: {
              create: { agentApiKey: `CIPHERTEXT(${key})` },
              update: { agentApiKey: `CIPHERTEXT(${key})` },
            },
          },
        }),
      })
    );
  });

  it('a subsequent read cannot produce the key that was just minted', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({ credentials: null });
    const mint = await request(app).post(BASE);
    const key = mint.body.data.apiKey as string;

    // The store now holds the ciphertext the mint wrote.
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: { agentApiKey: `CIPHERTEXT(${key})` },
      agentApiKeyRotatedAt: new Date(),
    });

    const status = await request(app).get(BASE);
    expect(status.body.data.hasKey).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(key);
  });

  it('mints a DIFFERENT key each time — never a derivable or reused value', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({ credentials: null });
    const a = (await request(app).post(BASE)).body.data.apiKey;
    const b = (await request(app).post(BASE)).body.data.apiKey;
    expect(a).not.toBe(b);
  });

  it('flags a rotation and immediately overwrites the previous ciphertext', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: { agentApiKey: 'CIPHERTEXT(fak_old)' },
    });

    const res = await request(app).post(BASE);

    expect(res.status).toBe(201);
    expect(res.body.data.rotated).toBe(true);
    const written = mockPrisma.store.update.mock.calls[0][0].data.credentials.upsert.update
      .agentApiKey as string;
    expect(written).not.toBe('CIPHERTEXT(fak_old)');
    // No overlap window: the old value is replaced, not kept alongside.
    expect(JSON.stringify(mockPrisma.store.update.mock.calls[0][0])).not.toContain('fak_old');
  });

  it('audits the issue with the acting user', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({ credentials: null });
    const res = await request(app).post(BASE);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.agent_key_issued', userId: 'admin-1' })
    );
    // The audit row must not carry the secret either.
    expect(JSON.stringify(mockAuditLog.mock.calls[0][0])).not.toContain(res.body.data.apiKey);
  });
});

describe('DELETE revoke — the column is actually cleared', () => {
  it('nulls agentApiKey, not just the rotation stamp', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: { agentApiKey: 'CIPHERTEXT(fak_live)' },
    });

    const res = await request(app).delete(BASE);

    expect(res.status).toBe(200);
    expect(res.body.data.hasKey).toBe(false);
    // A revoke that left the ciphertext in place would answer exactly the same
    // 200 while the old key kept authorising MCP writes.
    expect(mockPrisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STORE_ID },
        data: expect.objectContaining({
          credentials: { upsert: { create: { agentApiKey: null }, update: { agentApiKey: null } } },
        }),
      })
    );
  });

  it('audits the revoke and records whether there was a key to revoke', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({
      credentials: { agentApiKey: 'CIPHERTEXT(fak_live)' },
    });
    await request(app).delete(BASE);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.agent_key_revoked',
        details: expect.objectContaining({ hadKey: true }),
      })
    );
  });
});
