/**
 * Route-level tests for `payment-settings.routes.ts` — the super-admin
 * (global, `storeId: null`) and store-admin (per-store override) CRUD over
 * `PaymentConfig`, which holds encrypted provider secrets (Tap/MyFatoorah/
 * Hesabe/UPayments API keys, webhook secrets). No test file imported this
 * router before this one (GitHub #1547) — a revenue-critical surface with
 * zero test backstop.
 *
 * Boots a minimal Express app mounting only `payment-settings.routes` with
 * the auth chain stubbed out, the same app-bootstrap pattern as
 * `tests/unit/agent-credential-route.test.ts`. Only Prisma, the encryption
 * service, `PaymentService.clearCache` and the router's own
 * `tenantContext` param hook are mocked; `authorize`/`requireStoreAccess`
 * are stubbed pass-throughs (their own coverage lives elsewhere); the RBAC
 * `requirePermission` middleware runs FOR REAL against the role the
 * `authenticate` stub attaches, and the handlers run for real.
 *
 * Properties under test:
 *
 *   1. GET never returns the stored ciphertext or the real secret — every
 *      list/detail response is masked (`maskCredentials`).
 *   2. PUT/POST validation failure (bad provider enum) renders as a
 *      readable 400 VALIDATION_ERROR via the real Zod schema + error
 *      handler — not a raw stack trace.
 *   3. `isDefault` is exclusive per scope (global vs per-store): setting a
 *      new default unsets the previous one via `updateMany`.
 *   4. A masked placeholder value (`****`) submitted back on PUT does NOT
 *      get re-encrypted and re-stored — only a genuinely new secret is
 *      encrypted.
 *   5. Store-scoped routes 404 on an unknown store and 403 a store_admin
 *      who does not own the store (the route's own inline ownership
 *      check, defense-in-depth alongside the stubbed `requireStoreAccess`).
 *   6. #2010 — apiKey/merchantId display as `****` + the save-time
 *      fingerprint (last 4 of the PLAINTEXT), never any part of the
 *      ciphertext, and no read path decrypts. A row saved before the
 *      fingerprint existed shows `****` and flags "re-save to show".
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const { mockPrisma, mockClearCache, mockAuditLog, currentUser, decryptSpy } = vi.hoisted(() => ({
  // #2010: the read path must never decrypt — every GET asserts this spy idle.
  decryptSpy: vi.fn(),
  mockPrisma: {
    paymentConfig: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    store: { findUnique: vi.fn() },
  },
  mockClearCache: vi.fn(),
  mockAuditLog: vi.fn(),
  // Mutable — tests flip `.role`/`.userId` to exercise RBAC + the route's
  // own inline ownership check under the REAL `requirePermission`.
  currentUser: { userId: 'admin-1', role: 'super_admin' as string },
}));

vi.mock('@force/database', () => ({
  prisma: mockPrisma,
  // Type-only in the route file (`as PaymentProvider` / `: ProviderHealthStatus`
  // casts) — never dereferenced as a value at runtime, so undefined is fine.
  PaymentProvider: undefined,
  ProviderHealthStatus: undefined,
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { ...currentUser };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/security', () => ({
  auditLog: mockAuditLog,
}));

vi.mock('@api/services/payment.service', () => ({
  PaymentService: { clearCache: mockClearCache },
}));

// Reversible stand-in for AES-256-GCM so assertions can name the plaintext
// without a real ENCRYPTION_KEY, exactly like the encryption.service does
// (encrypt/decrypt are inverses) — `mask` is the REAL implementation
// (imported nowhere, reimplemented identically) so the masking-shape
// assertions exercise the real prefix+****+suffix behaviour.
vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    encrypt: (v: string) => `CIPHERTEXT(${v})`,
    decrypt: (v: string) => {
      decryptSpy(v);
      return String(v).replace(/^CIPHERTEXT\(|\)$/g, '');
    },
    mask: (v: string, visibleChars = 4) => {
      if (!v || v.length <= visibleChars * 2) return '****';
      return `${v.substring(0, visibleChars)}****${v.substring(v.length - visibleChars)}`;
    },
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── App bootstrap ──────────────────────────────────────────────────────────

let app: Express;
const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BASE = '/api/v1/payment-settings';

beforeAll(async () => {
  const { default: paymentSettingsRouter } = await import('@api/routes/payment-settings.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use(BASE, paymentSettingsRouter);
  server.use(errorHandler);
  app = server;
});

function baseConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cfg-1',
    provider: 'tap',
    storeId: null,
    isEnabled: true,
    isDefault: false,
    displayName: 'Tap',
    displayNameAr: null,
    apiKey: 'CIPHERTEXT(sk_live_the_real_tap_key)',
    secretKey: 'CIPHERTEXT(secret_value)',
    merchantId: 'CIPHERTEXT(merchant_123456)',
    webhookSecret: 'CIPHERTEXT(whsec_abcdef)',
    testMode: false,
    supportedMethods: ['card'],
    supportedCurrencies: ['EGP'],
    fixedFee: 0,
    percentageFee: 0,
    healthStatus: 'unknown',
    lastHealthCheck: null,
    createdBy: 'admin-1',
    updatedBy: 'admin-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.userId = 'admin-1';
  currentUser.role = 'super_admin';
  mockClearCache.mockReset();
});

// ─── GET — never the secrets, in any form ──────────────────────────────────

describe('GET /payment-settings — never the stored secret, in any form', () => {
  it('masks apiKey/merchantId and blanks secretKey/webhookSecret on the list', async () => {
    mockPrisma.paymentConfig.findMany.mockResolvedValue([baseConfig()]);

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    const config = res.body.data.configs[0];
    // Never the raw ciphertext or anything resembling the real secret.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('CIPHERTEXT');
    expect(raw).not.toContain('sk_live_the_real_tap_key');
    expect(raw).not.toContain('secret_value');
    expect(raw).not.toContain('whsec_abcdef');
    // secretKey/webhookSecret are fully blanked, never a partial reveal.
    expect(config.secretKey).toBe('****');
    expect(config.webhookSecret).toBe('****');
  });

  it('masks a single provider config on the detail route the same way', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(baseConfig());

    const res = await request(app).get(`${BASE}/tap`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('CIPHERTEXT');
    expect(res.body.data.config.secretKey).toBe('****');
  });

  it('404s a provider that has no global configuration', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/tap`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ─── POST — validation + isDefault exclusivity ─────────────────────────────

describe('POST /payment-settings — validation failure renders as a readable 400', () => {
  it('rejects an unknown provider enum with VALIDATION_ERROR, not a 500', async () => {
    const res = await request(app).post(BASE).send({ provider: 'not-a-real-provider' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.provider).toBeDefined();
    expect(mockPrisma.paymentConfig.create).not.toHaveBeenCalled();
  });

  it('409s creating a provider that is already configured globally', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(baseConfig());

    const res = await request(app).post(BASE).send({ provider: 'tap' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_EXISTS');
  });
});

describe('POST /payment-settings — isDefault is exclusive per scope', () => {
  it('unsets every other global default before creating the new one', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(null);
    mockPrisma.paymentConfig.create.mockResolvedValue(baseConfig({ isDefault: true }));

    const res = await request(app)
      .post(BASE)
      .send({ provider: 'tap', isDefault: true, apiKey: 'sk_new_key' });

    expect(res.status).toBe(201);
    expect(mockPrisma.paymentConfig.updateMany).toHaveBeenCalledWith({
      where: { storeId: null, isDefault: true },
      data: { isDefault: false },
    });
    // The new secret was actually encrypted before being persisted.
    expect(mockPrisma.paymentConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ apiKey: 'CIPHERTEXT(sk_new_key)' }),
      })
    );
    expect(mockClearCache).toHaveBeenCalledWith();
  });

  it('does not touch other defaults when isDefault is not set', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(null);
    mockPrisma.paymentConfig.create.mockResolvedValue(baseConfig());

    await request(app).post(BASE).send({ provider: 'cod' });

    expect(mockPrisma.paymentConfig.updateMany).not.toHaveBeenCalled();
  });
});

// ─── PUT — masked placeholders never get re-encrypted ──────────────────────

describe('PUT /payment-settings/:provider — a masked placeholder is not re-stored as a secret', () => {
  it('drops apiKey/secretKey from the update when the client echoes the mask back', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(baseConfig({ id: 'cfg-1' }));
    mockPrisma.paymentConfig.update.mockResolvedValue(baseConfig({ id: 'cfg-1' }));

    await request(app)
      .put(`${BASE}/tap`)
      .send({ apiKey: 'sk_l****_key', secretKey: '****', isEnabled: false });

    const updateCall = mockPrisma.paymentConfig.update.mock.calls[0][0];
    expect(updateCall.data.apiKey).toBeUndefined();
    expect(updateCall.data.secretKey).toBeUndefined();
    expect(updateCall.data.isEnabled).toBe(false);
  });

  it('encrypts a genuinely new secretKey that does not contain the mask marker', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(baseConfig({ id: 'cfg-1' }));
    mockPrisma.paymentConfig.update.mockResolvedValue(baseConfig({ id: 'cfg-1' }));

    await request(app).put(`${BASE}/tap`).send({ secretKey: 'brand_new_secret' });

    const updateCall = mockPrisma.paymentConfig.update.mock.calls[0][0];
    expect(updateCall.data.secretKey).toBe('CIPHERTEXT(brand_new_secret)');
  });

  it('404s updating a provider with no existing global configuration', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(null);

    const res = await request(app).put(`${BASE}/tap`).send({ isEnabled: true });

    expect(res.status).toBe(404);
    expect(mockPrisma.paymentConfig.update).not.toHaveBeenCalled();
  });
});

// ─── Store-scoped routes — ownership + ordinary provider-enable flow ───────

describe('Store-scoped payment settings — ownership + not-found', () => {
  it('404s a store that does not exist', async () => {
    mockPrisma.store.findUnique.mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/store/${STORE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('403s a store_admin who does not own the store', async () => {
    currentUser.role = 'store_admin';
    currentUser.userId = 'not-the-owner';
    mockPrisma.store.findUnique.mockResolvedValue({ id: STORE_ID, ownerId: 'someone-else' });

    const res = await request(app).get(`${BASE}/store/${STORE_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets the owning store_admin read their own store configs, masked', async () => {
    currentUser.role = 'store_admin';
    currentUser.userId = 'owner-1';
    mockPrisma.store.findUnique.mockResolvedValue({ id: STORE_ID, ownerId: 'owner-1' });
    mockPrisma.paymentConfig.findMany
      .mockResolvedValueOnce([baseConfig({ storeId: STORE_ID })]) // storeConfigs
      .mockResolvedValueOnce([]); // globalConfigs

    const res = await request(app).get(`${BASE}/store/${STORE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.storeConfigs[0].secretKey).toBe('****');
    expect(JSON.stringify(res.body)).not.toContain('CIPHERTEXT');
  });
});

// ─── /:provider/toggle and /:provider/set-default — the enable/default logic ──

describe('POST /payment-settings/:provider/toggle', () => {
  it('flips isEnabled and audits the action with the acting user', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(baseConfig({ isEnabled: true }));
    mockPrisma.paymentConfig.update.mockResolvedValue(baseConfig({ isEnabled: false }));

    const res = await request(app).post(`${BASE}/tap/toggle`).send({ enabled: false });

    expect(res.status).toBe(200);
    expect(mockPrisma.paymentConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isEnabled: false }) })
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment_config.disabled', userId: 'admin-1' })
    );
    expect(mockClearCache).toHaveBeenCalledWith();
  });
});

describe('POST /payment-settings/:provider/set-default', () => {
  it('unsets every other default then sets this provider as the sole default', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(baseConfig({ isDefault: false }));
    mockPrisma.paymentConfig.update.mockResolvedValue(baseConfig({ isDefault: true }));

    const res = await request(app).post(`${BASE}/tap/set-default`);

    expect(res.status).toBe(200);
    expect(mockPrisma.paymentConfig.updateMany).toHaveBeenCalledWith({
      where: { storeId: null, isDefault: true },
      data: { isDefault: false },
    });
    expect(mockPrisma.paymentConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) })
    );
  });

  it('404s setting a non-configured provider as default', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(null);

    const res = await request(app).post(`${BASE}/tap/set-default`);

    expect(res.status).toBe(404);
    expect(mockPrisma.paymentConfig.updateMany).not.toHaveBeenCalled();
  });
});

// ─── #2010 — which key is saved, without decrypting ────────────────────────

describe('#2010 — credential display fingerprint', () => {
  it('shows ****<last4 of the plaintext> from the stored fingerprint, never the ciphertext, and never decrypts', async () => {
    mockPrisma.paymentConfig.findMany.mockResolvedValue([
      baseConfig({ apiKeyLast4: '_key', merchantIdLast4: '3456' }),
    ]);

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    const config = res.body.data.configs[0];
    expect(config.apiKey).toBe('****_key');
    expect(config.merchantId).toBe('****3456');
    expect(config.apiKeyFingerprintMissing).toBe(false);
    expect(config.merchantIdFingerprintMissing).toBe(false);
    // The old mask was `encryption.mask(<ciphertext>)` → "CIPH****key)".
    // No fragment of the stored value may appear, however short.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('CIPH');
    expect(raw).not.toContain('xt)');
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('a row saved before the fingerprint existed shows **** and flags re-save', async () => {
    currentUser.role = 'store_admin';
    currentUser.userId = 'owner-1';
    mockPrisma.store.findUnique.mockResolvedValue({ id: STORE_ID, ownerId: 'owner-1' });
    mockPrisma.paymentConfig.findMany
      .mockResolvedValueOnce([baseConfig({ storeId: STORE_ID, apiKeyLast4: null })])
      .mockResolvedValueOnce([]);

    const res = await request(app).get(`${BASE}/store/${STORE_ID}`);

    const config = res.body.data.storeConfigs[0];
    expect(config.apiKey).toBe('****');
    expect(config.merchantId).toBe('****');
    expect(config.apiKeyFingerprintMissing).toBe(true);
    expect(config.merchantIdFingerprintMissing).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('CIPH');
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('a row with no key at all returns null and no re-save flag', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(
      baseConfig({ apiKey: null, merchantId: null })
    );

    const res = await request(app).get(`${BASE}/tap`);

    expect(res.body.data.config.apiKey).toBeNull();
    expect(res.body.data.config.apiKeyFingerprintMissing).toBe(false);
  });

  it('stores the fingerprint next to the ciphertext on create', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(null);
    mockPrisma.paymentConfig.create.mockResolvedValue(baseConfig());

    await request(app)
      .post(BASE)
      .send({ provider: 'tap', apiKey: 'sk_new_key_WXYZ', merchantId: 'merchant_987' });

    expect(mockPrisma.paymentConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKey: 'CIPHERTEXT(sk_new_key_WXYZ)',
          apiKeyLast4: 'WXYZ',
          merchantId: 'CIPHERTEXT(merchant_987)',
          merchantIdLast4: '_987',
        }),
      })
    );
  });

  it('updates the fingerprint when a store key is re-saved, and leaves it alone on a masked echo', async () => {
    currentUser.role = 'store_admin';
    currentUser.userId = 'owner-1';
    mockPrisma.store.findUnique.mockResolvedValue({ id: STORE_ID, ownerId: 'owner-1' });
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(
      baseConfig({ id: 'cfg-1', storeId: STORE_ID })
    );
    mockPrisma.paymentConfig.update.mockResolvedValue(baseConfig({ id: 'cfg-1' }));

    await request(app).put(`${BASE}/store/${STORE_ID}/tap`).send({ apiKey: 'sk_rotated_ABCD' });
    const saved = mockPrisma.paymentConfig.update.mock.calls[0][0].data;
    expect(saved.apiKey).toBe('CIPHERTEXT(sk_rotated_ABCD)');
    expect(saved.apiKeyLast4).toBe('ABCD');

    mockPrisma.paymentConfig.update.mockClear();
    await request(app).put(`${BASE}/store/${STORE_ID}/tap`).send({ apiKey: '****ABCD' });
    const echoed = mockPrisma.paymentConfig.update.mock.calls[0][0].data;
    expect(echoed.apiKey).toBeUndefined();
    expect(echoed.apiKeyLast4).toBeUndefined();
  });
});
