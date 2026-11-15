/**
 * SELF-SERVICE gap A7 (task 12): a merchant turns on a payment gateway / carrier WITHOUT a super admin.
 *
 *  - step 1 (preview): the SERVER runs Test connection (nothing in the body can make it pass); a pass returns a
 *    single-use confirm token, a failure returns a plain sentence (AI explains, code decides) and no token;
 *  - step 2 (confirm): token bound to a hash of {provider, mode, that test run} + Idempotency-Key; replay, edited
 *    payload, other user and other store are refused; success enables the provider, appends an append-only ledger
 *    row, raises the P1 for the first connection; a failed ledger write switches the provider off again;
 *  - the super admin keeps `deactivate`; a store_admin cannot use it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const m = vi.hoisted(() => {
  const state = {
    row: null as null | Record<string, any>,
    requests: [] as Array<Record<string, any>>,
    ledger: [] as Array<Record<string, any>>,
    result: { ok: true, code: 'ok', message: 'ok' } as {
      ok: boolean;
      code: string;
      message: string;
    },
    now: 1,
    ledgerFails: false,
    writeDelay: 0,
    fixedAt: false,
    reads: 0,
    onAfterReads: 0,
    kv: new Map<string, string>(),
  };
  return {
    state,
    sendAlert: vi.fn(async () => undefined),
    auditLog: vi.fn(async () => undefined),
    triage: vi.fn(),
    reportCheck: vi.fn(async () => undefined),
    verified: vi.fn(async () => false),
    carrierUpsert: vi.fn(async () => ({})),
  };
});

vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = {
        userId: req.header('x-user') ?? 'u1',
        role: req.header('x-role') ?? 'store_admin',
        email: 'owner@example.test',
      };
      next();
    },
    rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/security')>(
    '@api/middleware/security'
  );
  return { ...real, auditLog: m.auditLog };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/00000000-0000-4000-8000-000000000001ccess', () => ({
  requireStoreAccess: (req: any, res: any, next: any) =>
    req.params.storeId === '00000000-0000-4000-8000-000000000001'
      ? next()
      : res.status(404).json({ success: false }),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _s: any, n: any) => n(),
  storeScopeContext: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/platform-scope', () => ({
  asOperator: async (_u: string, fn: () => Promise<unknown>) => fn(),
  platformHubOnD1: async () => false,
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: m.sendAlert }));
vi.mock('@api/services/email-queue.service', () => ({ emailQueue: { enqueue: vi.fn() } }));
vi.mock('@api/services/payment.service', () => ({ PaymentService: { clearCache: vi.fn() } }));
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: {
    testConnection: vi.fn(),
    upsertCarrierConfig: m.carrierUpsert,
    invalidateCarrierConfigCache: vi.fn(async () => undefined),
  },
}));
vi.mock('@api/services/ai.service', () => ({ AIService: { triageProviderCheck: m.triage } }));
vi.mock('@api/services/provider-verification.service', async () => {
  const real = await vi.importActual<any>('@api/services/provider-verification.service');
  return { ...real, isProviderVerified: m.verified, reportConnectionCheck: m.reportCheck };
});
vi.mock('@api/services/redis.service', () => {
  const client = {
    set: async (k: string, v: string, ..._a: unknown[]) => {
      const nx = _a.includes('NX');
      if (nx && m.state.kv.has(k)) return null;
      m.state.kv.set(k, v);
      return 'OK';
    },
    get: async (k: string) => m.state.kv.get(k) ?? null,
    del: async (k: string) => void m.state.kv.delete(k),
  };
  return {
    redis: { getClient: () => client, isAvailable: () => true, get: vi.fn(), set: vi.fn() },
  };
});
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    paymentConfig: {
      findFirst: async () => {
        m.state.reads++;
        // a competing confirm finished between this one's pre-check and its claim
        if (m.state.onAfterReads && m.state.reads > m.state.onAfterReads && m.state.row) {
          m.state.row.isEnabled = true;
        }
        return m.state.row ? { ...m.state.row } : null;
      },
    },
    shippingCarrierConfig: { findUnique: async () => null },
  }),
  storeWriter: async () => ({
    paymentConfig: {
      update: async ({ data }: any) => {
        if (m.state.writeDelay) await new Promise(r => setTimeout(r, m.state.writeDelay));
        m.state.row = { ...m.state.row!, ...data };
        return m.state.row;
      },
    },
  }),
  storeRepo: async () => ({ backend: 'pg' }),
}));
vi.mock('@api/services/payment-providers/provider-connection.service', async () => {
  const real = await vi.importActual<any>(
    '@api/services/payment-providers/provider-connection.service'
  );
  return {
    ...real,
    runConnectionTest: async () => {
      const at = m.state.fixedAt ? 'same-instant' : `t${m.state.now++}`;
      return {
        result: m.state.result,
        stored: {
          ok: m.state.result.ok,
          code: m.state.result.code,
          mode: 'sandbox',
          at,
          fingerprint: 'fp',
        },
      };
    },
    // The stored test is "current" while credentials are unchanged (a flag the test can flip).
    connectionTestLooksCurrent: (row: any) =>
      row.connectionTest?.ok === true && row.credentialsEdited !== true,
    connectionTestIsCurrent: (row: any) =>
      row.connectionTest?.ok === true && row.credentialsEdited !== true,
    assertEnableAllowed: (row: any) => {
      if (!(row.connectionTest?.ok === true && row.credentialsEdited !== true)) {
        const { AppError } = require('@api/middleware/error-handler');
        throw new AppError(409, 'CONNECTION_NOT_TESTED', 'not tested');
      }
    },
  };
});
vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<any>('@ebda/database');
  const { state } = m;
  const prisma = {
    store: {
      findUnique: async () => ({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Shop A',
        ownerId: 'u1',
      }),
    },
    providerActivationRequest: {
      findFirst: async () =>
        state.requests.find(r => ['requested', 'activated'].includes(r.status)) ?? null,
      create: async ({ data }: any) => {
        const r = { id: `req-${state.requests.length + 1}`, requestedAt: new Date(), ...data };
        state.requests.push(r);
        return r;
      },
      update: async ({ where, data }: any) => {
        const r = state.requests.find(x => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = state.requests.filter(r => r.status === where.status);
        hit.forEach(r => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    providerVerificationEvent: {
      create: async ({ data }: any) => {
        if (state.ledgerFails) throw new Error('db down');
        state.ledger.push(data);
        return data;
      },
      findMany: async ({ where, take }: any) =>
        [...state.ledger]
          .reverse()
          .filter(
            l =>
              l.provider === where.provider &&
              (where.sourceStoreId === undefined || l.sourceStoreId === where.sourceStoreId) &&
              where.op.in.includes(l.op)
          )
          .slice(0, take)
          .map(l => ({ op: l.op })),
    },
  };
  return { ...real, prisma, withStore: async (_id: string, fn: any) => fn(prisma) };
});

const HUMAN = { sentence: 'Check that the key belongs to this mode.' };
let app: Express;
beforeAll(async () => {
  const routes = await import('@api/routes/provider-activation.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/provider-activation', routes.default);
  app.use('/admin', routes.adminProviderActivationRoutes);
  app.use(errorHandler as any);
});
beforeEach(() => {
  const s = m.state;
  s.row = {
    id: 'cfg1',
    provider: 'kashier',
    storeId: '00000000-0000-4000-8000-000000000001',
    credentials: 'enc',
    isEnabled: false,
    testMode: true,
    connectionTest: null,
  };
  s.requests = [];
  s.ledger = [];
  s.result = { ok: true, code: 'ok', message: 'ok' };
  s.now = 1;
  s.ledgerFails = false;
  s.writeDelay = 0;
  s.fixedAt = false;
  s.reads = 0;
  s.onAfterReads = 0;
  s.kv.clear();
  m.sendAlert.mockClear();
  m.auditLog.mockClear();
  m.reportCheck.mockClear();
  m.carrierUpsert.mockClear();
  m.verified.mockReset().mockResolvedValue(false);
  m.triage
    .mockReset()
    .mockResolvedValue({ en: HUMAN.sentence, ar: 'راجع إن المفتاح بتاع الوضع ده.' });
});

const FIRST_ATTEMPT = 'attempt-12345678';
const base = '/provider-activation/store/00000000-0000-4000-8000-000000000001/kashier/activate';
const preview = (role = 'store_admin', user = 'u1') =>
  request(app).post(`${base}/preview`).set('x-role', role).set('x-user', user).send({});
const confirm = (
  token: string,
  attempt = FIRST_ATTEMPT,
  role = 'store_admin',
  user = 'u1',
  path = base
) =>
  request(app)
    .post(`${path}/confirm`)
    .set('x-role', role)
    .set('x-user', user)
    .set('Idempotency-Key', attempt)
    .send({ confirmToken: token });

describe('step 1: the server runs the check', () => {
  it('a passing test returns a token and changes nothing yet', async () => {
    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('ready');
    expect(res.body.data.confirmToken).toMatch(/\./);
    expect(m.state.row!.isEnabled).toBe(false);
    expect(m.state.ledger).toHaveLength(0);
  });

  it('a body claiming the test passed cannot make a failing test pass', async () => {
    m.state.result = { ok: false, code: 'bad_credentials', message: 'no' };
    const res = await request(app)
      .post(`${base}/preview`)
      .send({ test: { ok: true, code: 'ok' }, ok: true, passed: true, confirmToken: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('failed');
    expect(res.body.data.confirmToken).toBeUndefined();
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('a failure returns the AI sentence, or the fixed sentence when the AI is unavailable', async () => {
    m.state.result = { ok: false, code: 'bad_credentials', message: 'no' };
    const ai = await preview();
    expect(ai.body.data.triage).toMatchObject({ en: HUMAN.sentence, source: 'ai' });
    m.triage.mockRejectedValue(new Error('ai down'));
    const fixed = await preview();
    expect(fixed.body.data.triage.source).toBe('fixed');
    expect(fixed.body.data.triage.en).toBe(fixed.body.data.check.messageEn);
  });

  it('an unreachable provider never spends an AI call', async () => {
    m.state.result = { ok: false, code: 'unreachable', message: 'x' };
    const res = await preview();
    expect(res.body.data.triage.source).toBe('fixed');
    expect(m.triage).not.toHaveBeenCalled();
  });

  it('a provider with no saved credentials is refused and nothing is tested', async () => {
    m.state.row!.credentials = null;
    expect((await preview()).status).toBe(422);
  });

  it('another store is 404, a customer 403, a non-owner store_admin 403', async () => {
    expect(
      (await request(app).post('/provider-activation/store/store-b/kashier/activate/preview'))
        .status
    ).toBe(404);
    expect((await preview('customer')).status).toBe(403);
    expect((await preview('store_admin', 'someone-else')).status).toBe(403);
  });
});

describe('step 2: confirm', () => {
  it('turns the provider on, writes the ledger row, the request row, the audit row and pages ops', async () => {
    const token = (await preview()).body.data.confirmToken;
    const res = await confirm(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ activated: true, provider: 'kashier', mode: 'sandbox' });
    expect(m.state.row!.isEnabled).toBe(true);
    expect(m.state.ledger).toEqual([
      expect.objectContaining({
        provider: 'kashier',
        sourceStoreId: '00000000-0000-4000-8000-000000000001',
        op: 'activation.activated_self',
      }),
    ]);
    expect(m.state.requests[0]).toMatchObject({ status: 'activated', decidedById: 'u1' });
    expect(m.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provider_activation.self_activated',
        storeId: '00000000-0000-4000-8000-000000000001',
        userId: 'u1',
      })
    );
    await vi.waitFor(() =>
      expect(m.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'p1', source: 'provider.activation.first_connection' })
      )
    );
  });

  it('no Idempotency-Key = 400 and nothing is turned on', async () => {
    const token = (await preview()).body.data.confirmToken;
    const res = await request(app).post(`${base}/confirm`).send({ confirmToken: token });
    expect(res.status).toBe(400);
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('no token / a forged token = refused', async () => {
    await preview();
    expect(
      (await request(app).post(`${base}/confirm`).set('Idempotency-Key', FIRST_ATTEMPT).send({}))
        .status
    ).toBe(400);
    const forged = await confirm('a'.repeat(30) + '.' + 'b'.repeat(64));
    expect(forged.status).toBe(409);
    expect(forged.body.error.code).toBe('CONFIRMATION_INVALID');
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('the same Idempotency-Key replays the first answer and enables once', async () => {
    const token = (await preview()).body.data.confirmToken;
    const a = await confirm(token, 'attempt-same-1234');
    const b = await confirm(token, 'attempt-same-1234');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.data.replayed).toBe(true);
    expect(m.state.ledger).toHaveLength(1);
  });

  it('a token is single use: replaying it after the provider was switched off is refused', async () => {
    const token = (await preview()).body.data.confirmToken;
    expect((await confirm(token, 'attempt-aaaaaaaa')).status).toBe(200);
    m.state.row!.isEnabled = false;
    const replay = await confirm(token, 'attempt-bbbbbbbb');
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('CONFIRMATION_USED');
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('an edited payload is refused: a token from an older test run no longer matches', async () => {
    const first = (await preview()).body.data.confirmToken;
    await preview(); // a new test run replaces the proven payload
    const res = await confirm(first);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMATION_INVALID');
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('a token minted for one user cannot be used by another', async () => {
    const token = (await preview()).body.data.confirmToken;
    const res = await confirm(token, 'attempt-cccccccc', 'super_admin', 'op-9');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMATION_INVALID');
  });

  it('credentials edited after the preview: the gate refuses even with a valid token', async () => {
    const token = (await preview()).body.data.confirmToken;
    m.state.row!.credentialsEdited = true;
    const res = await confirm(token, 'attempt-dddddddd');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONNECTION_NOT_TESTED');
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('a failed ledger write switches the provider off again and frees the key for a retry', async () => {
    const token = (await preview()).body.data.confirmToken;
    m.state.ledgerFails = true;
    const res = await confirm(token, 'attempt-eeeeeeee');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(m.state.row!.isEnabled).toBe(false);
    // the request is marked failed (rejected + note), never left `activated` without its ledger row
    expect(m.state.requests[0]).toMatchObject({ status: 'rejected' });
    expect(m.state.requests[0].note).toMatch(/failed/);
    expect(m.state.kv.has([...m.state.kv.keys()].find(k => k.startsWith('idem:')) ?? '')).toBe(
      false
    );
  });

  it('an unverified provider pages ops (P1); a verified one does not', async () => {
    m.verified.mockResolvedValue(true);
    const token = (await preview()).body.data.confirmToken;
    await confirm(token);
    await new Promise(r => setTimeout(r, 20));
    expect(m.sendAlert).not.toHaveBeenCalled();
  });
});

describe('super admin overrides', () => {
  it('deactivate turns the provider off for one store, closes the request, appends a ledger row', async () => {
    const token = (await preview()).body.data.confirmToken;
    await confirm(token);
    const res = await request(app)
      .post('/admin/provider-activation/00000000-0000-4000-8000-000000000001/kashier/deactivate')
      .set('x-role', 'super_admin')
      .send({ note: 'chargeback abuse' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'kashier', wasEnabled: true });
    expect(m.state.row!.isEnabled).toBe(false);
    expect(m.state.requests[0]).toMatchObject({ status: 'rejected', note: 'chargeback abuse' });
    expect(m.state.ledger.map(l => l.op)).toEqual([
      'activation.activated_self',
      'activation.deactivated',
    ]);
  });

  it('a store_admin cannot deactivate', async () => {
    const res = await request(app)
      .post('/admin/provider-activation/00000000-0000-4000-8000-000000000001/kashier/deactivate')
      .set('x-role', 'store_admin')
      .send({ note: 'because' });
    expect(res.status).toBe(403);
  });
});

describe('a super-admin deactivate sticks (blocked by admin)', () => {
  const deactivate = () =>
    request(app)
      .post('/admin/provider-activation/00000000-0000-4000-8000-000000000001/kashier/deactivate')
      .set('x-role', 'super_admin')
      .send({ note: 'chargeback abuse' });
  const unblock = (role = 'super_admin') =>
    request(app)
      .post('/admin/provider-activation/00000000-0000-4000-8000-000000000001/kashier/unblock')
      .set('x-role', role)
      .send({});

  it('after a deactivate the merchant cannot run the flow again, even with an older token', async () => {
    const early = (await preview()).body.data.confirmToken; // minted before the block
    const token = (await preview()).body.data.confirmToken;
    expect((await confirm(token)).status).toBe(200);
    expect((await deactivate()).status).toBe(200);
    const again = await preview();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROVIDER_BLOCKED');
    const replay = await confirm(early, 'attempt-ffffffff');
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('PROVIDER_BLOCKED');
    expect(m.state.row!.isEnabled).toBe(false);
  });

  it('unblock lifts the flag; only super_admin can, and only when blocked', async () => {
    expect((await unblock()).status).toBe(409); // not blocked
    const token = (await preview()).body.data.confirmToken;
    await confirm(token);
    await deactivate();
    expect((await unblock('store_admin')).status).toBe(403);
    expect((await unblock()).status).toBe(200);
    expect((await preview()).body.data.outcome).toBe('ready');
    expect(m.state.ledger.map(l => l.op)).toContain('activation.unblocked');
  });
});

describe('two concurrent confirms (different tokens and keys) for the same store + provider', () => {
  it('exactly one runs the enable -> ledger sequence; the loser never switches the provider off', async () => {
    // Two previews whose test runs share one timestamp (ms resolution) mint two DIFFERENT valid tokens for the same payload
    // hash; normally a newer test run invalidates the older token, here it cannot.
    m.state.fixedAt = true;
    const t1 = (await preview()).body.data.confirmToken;
    const t2 = (await preview()).body.data.confirmToken;
    m.state.writeDelay = 15; // the two confirms really overlap
    const [a, b] = await Promise.all([
      confirm(t1, 'attempt-race-0001'),
      confirm(t2, 'attempt-race-0002'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(['ACTIVATION_IN_PROGRESS', 'ALREADY_ACTIVE', 'CONFIRMATION_INVALID']).toContain(
      lost.body.error.code
    );
    expect(m.state.row!.isEnabled).toBe(true);
    expect(m.state.ledger.filter(l => l.op === 'activation.activated_self')).toHaveLength(1);
  });
});

describe('a confirm that lost the race after its pre-check', () => {
  it('re-checks "already on" inside the claim: no second enable, no second ledger row', async () => {
    const token = (await preview()).body.data.confirmToken;
    m.state.reads = 0;
    m.state.onAfterReads = 1; // the pre-check read sees "off"; every later read sees "on"
    const res = await confirm(token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_ACTIVE');
    expect(m.state.ledger).toHaveLength(0);
  });
});

describe('guards around the feature', () => {
  it('the ledger is append-only in the database, and nothing in the API updates or deletes an event', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../packages/database/prisma/migrations/20261114000100_provider_activation_ledger_append_only/migration.sql'
      ),
      'utf8'
    );
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON provider_verification_events/);
    expect(sql).toMatch(/OLD\.op LIKE 'activation\.%'/);
    const svc = readFileSync(
      join(__dirname, '../../apps/api/src/services/provider-activation.service.ts'),
      'utf8'
    );
    const ver = readFileSync(
      join(__dirname, '../../apps/api/src/services/provider-verification.service.ts'),
      'utf8'
    );
    for (const src of [svc, ver]) {
      expect(src).not.toMatch(
        /providerVerificationEvent\.(update|updateMany|delete|deleteMany|upsert)/
      );
    }
  });

  it('the first-real-use alert ignores activation ledger rows', () => {
    const ver = readFileSync(
      join(__dirname, '../../apps/api/src/services/provider-verification.service.ts'),
      'utf8'
    );
    expect(ver).toMatch(/NOT: \{ op: \{ startsWith: 'activation\.' \} \}/);
  });
});
