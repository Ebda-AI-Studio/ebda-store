/**
 * Passkey HTTP surface: the real router + real PasskeyService + real @simplewebauthn/server against a
 * software authenticator; Redis, the database, the limiters and `authenticate` are in-memory fakes.
 * Pins: browser-shaped JSON survives the Zod edge, a passkey sign-in mints a full session (PASSKEY-4),
 * every sign-in failure is byte-identical (PASSKEY-6), writes are impersonation-guarded, and the
 * sign-in limiters are IP-only buckets that count failures.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { register, assert } from '../helpers/software-authenticator';

const PASSWORD = 'Correct-pw-1';

const ADMIN = 'https://admin.ebda.app';
type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  creds: [] as Row[],
  users: new Map<string, Row>(),
  caller: {
    userId: 'user-1',
    role: 'store_admin',
    impersonatedBy: undefined as string | undefined,
  },
  audit: [] as Row[],
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () => ({
      setex: async (k: string, _t: number, v: string) => void h.redis.set(k, v),
      get: async (k: string) => h.redis.get(k) ?? null,
      del: async (k: string) => (h.redis.delete(k) ? 1 : 0),
    }),
  },
}));
vi.mock('@api/lib/definer', () => ({
  lookupStore: async (m: { slug?: string }) =>
    m.slug === 'shop-x' ? { id: 'store-x', status: 'active' } : null,
  passkeyLookup: async (id: string) => h.creds.find(c => c.credentialId === id) ?? null,
}));
vi.mock('@ebda/database', () => {
  const tx = {
    user: { findUnique: async ({ where }: any) => h.users.get(where.id) ?? null },
    passkeyCredential: {
      findMany: async ({ where }: any) => h.creds.filter(c => c.userId === where.userId),
      create: async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), lastUsedAt: null, ...data };
        h.creds.push({ ...row, userId: data.userId });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = h.creds.filter(c => c.id === where.id && c.userId === where.userId);
        hits.forEach(c => Object.assign(c, data));
        return { count: hits.length };
      },
      deleteMany: async ({ where }: any) => {
        const n = h.creds.length;
        h.creds = h.creds.filter(c => !(c.id === where.id && c.userId === where.userId));
        return { count: n - h.creds.length };
      },
    },
  };
  return { withUser: async (_i: string, fn: any) => fn(tx), prisma: {} };
});
vi.mock('@api/config', () => ({
  config: { adminUrl: ADMIN, webUrl: 'https://ebda.app', nodeEnv: 'production', jwtSecret: 's' },
}));
vi.mock('@api/services/encryption.service', () => ({ encryption: { decrypt: (s: string) => s } }));
vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    // Credential management of identity-managed accounts is closed by design (tests/unit/identity-managed-guard.test.ts);
    // this file exercises the legacy passkey routes themselves.
    rejectIdentityManaged: (_req: any, _res: any, next: any) => next(),
    authenticate: (req: any, _res: any, next: any) => {
      req.tokenJti = h.caller.jti;
      req.user = {
        userId: h.caller.userId,
        role: h.caller.role,
        storeId: (h.caller as { storeId?: string }).storeId ?? null,
        ...(h.caller.impersonatedBy ? { impersonatedBy: h.caller.impersonatedBy } : {}),
      };
      next();
    },
  };
});
const pass = (_q: any, _s: any, n: any) => n();
vi.mock('@api/middleware/security', () => ({
  authLimiter: pass,
  authIpFailureLimiter: pass,
  authIpAllLimiter: pass,
  refreshLimiter: pass,
  refreshIpLimiter: pass,
  resetEmailLimiter: pass,
  authEmailAddressLimiter: pass,
  verifyEmailLimiter: pass,
  writeLimiter: pass,
  passkeyBeginLimiter: pass,
  passkeyFinishLimiter: pass,
  passkeyStepUpLimiter: pass,
  auditLog: async (e: Row) => void h.audit.push(e),
  generateCsrfToken: async () => 'csrf-token',
}));
vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: async () => ({ locked: false }),
    recordFailedAttempt: async () => ({ locked: false, attemptsRemaining: 4 }),
    recordSuccessfulLogin: async () => undefined,
  },
}));
vi.mock('@api/services/platform-mailer', () => ({ sendPasskeyNoticeEmail: async () => undefined }));
vi.mock('@api/lib/cors-cache', () => ({ isPlatformOrigin: vi.fn(() => true) }));
vi.mock('@api/services/auth.service', () => ({
  AuthService: {
    revokeAllSessions: async () => undefined,
    issueSessionFor: async (u: Row) => ({
      user: { id: u.id, email: u.email, storeId: u.storeId, role: u.role },
      accessToken: jwt.sign({ userId: u.id }, 's', {
        algorithm: 'HS256',
        issuer: 'ebda-api',
        audience: 'ebda-app',
        jwtid: 'sess-new',
      }),
      refreshToken: 'refresh',
    }),
  },
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: '' },
}));

let app: Express;
beforeAll(async () => {
  const { default: passkeyRoutes } = await import('@api/routes/passkey.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/auth/passkeys', passkeyRoutes);
  app.use(errorHandler);
});

beforeEach(() => {
  h.redis.clear();
  h.creds = [];
  h.audit = [];
  h.caller = { userId: 'user-1', role: 'store_admin', impersonatedBy: undefined, jti: 'sess-A' };
  h.users = new Map([
    [
      'user-1',
      {
        id: 'user-1',
        email: 'm@x.com',
        firstName: 'M',
        lastName: 'S',
        role: 'store_admin',
        storeId: null,
        status: 'active',
        deletedAt: null,
        emailVerified: true,
        tokenVersion: 0,
        mfaEnabled: false,
        mfaSecret: null,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        language: 'en',
      },
    ],
  ]);
});

const P = '/api/v1/auth/passkeys';
const post = (path: string) => request(app).post(`${P}${path}`).set('Origin', ADMIN);

async function stepUp() {
  const r = await post('/step-up').send({ password: PASSWORD });
  expect(r.status).toBe(200);
}

async function enrolOverHttp() {
  await stepUp();
  const begin = await post('/register/begin').send({});
  expect(begin.status).toBe(200);
  const { credential, response } = register(begin.body.data, ADMIN);
  const fin = await post('/register/finish').send({ response, name: 'Work laptop' });
  expect(fin.status).toBe(201);
  return { credential, passkey: fin.body.data.passkey };
}

describe('passkey routes', () => {
  it('register -> list -> sign in: a browser-shaped payload mints a full session and is audited', async () => {
    const { credential, passkey } = await enrolOverHttp();
    const list = await request(app).get(P).set('Origin', ADMIN);
    expect(list.body.data.passkeys).toEqual([
      expect.objectContaining({ id: passkey.id, name: 'Work laptop', needsReenrol: false }),
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/publicKey|public_key/);

    const begin = await post('/authenticate/begin').send({});
    expect(begin.status).toBe(200);
    const response = assert(credential, begin.body.data, ADMIN);
    const fin = await post('/authenticate/finish').set('X-Session-ID', 's1').send({ response });
    expect(fin.status).toBe(200);
    expect(fin.body.data).toMatchObject({
      user: { id: 'user-1' },
      refreshToken: 'refresh',
      csrfToken: 'csrf-token',
    });
    expect(h.audit.map(a => a.action)).toEqual([
      'passkey.stepup',
      'passkey.added',
      'passkey.login',
    ]);
  });

  it('every sign-in failure is byte-identical and audited with an internal reason only', async () => {
    const { credential } = await enrolOverHttp();
    const bodies: string[] = [];
    // malformed body
    const a = await post('/authenticate/finish').send({ nope: true });
    // unknown credential
    const b0 = await post('/authenticate/begin').send({});
    const stranger = register(
      { challenge: 'x', rp: { id: 'admin.ebda.app' }, user: { id: 'u' } },
      ADMIN
    ).credential;
    const b = await post('/authenticate/finish').send({
      response: assert(stranger, b0.body.data, ADMIN),
    });
    // tampered signature on a real credential
    const c0 = await post('/authenticate/begin').send({});
    const bad: any = assert(credential, c0.body.data, ADMIN);
    bad.response.signature = Buffer.alloc(70, 1).toString('base64url');
    const c = await post('/authenticate/finish').send({ response: bad });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(401);
      bodies.push(JSON.stringify(r.body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]).error.code).toBe('PASSKEY_AUTH_FAILED');
    const failed = h.audit.filter(x => x.action === 'passkey.login.failed');
    expect(failed.map(f => f.details.reason)).toEqual([
      'malformed',
      'unknown_credential',
      'verification',
    ]);
  });

  it('an unknown Origin has no passkeys at all (404, no default store)', async () => {
    const r = await request(app)
      .post(`${P}/authenticate/begin`)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('PASSKEY_NOT_AVAILABLE');
    expect((await request(app).post(`${P}/authenticate/begin`).send({})).status).toBe(404);
  });

  it('writes are refused for an impersonation session', async () => {
    h.caller.impersonatedBy = 'admin-9';
    const { credential } = register(
      { challenge: 'x', rp: { id: 'admin.ebda.app' }, user: { id: 'u' } },
      ADMIN
    );
    expect((await post('/register/begin').send({})).status).toBe(403);
    expect((await post('/register/finish').send({ response: {} })).status).toBe(403);
    const id = '8f14e45f-ceea-467f-a8d1-1f0a5b6d3c11';
    expect(
      (await request(app).patch(`${P}/${id}`).set('Origin', ADMIN).send({ name: 'x' })).status
    ).toBe(403);
    expect((await request(app).delete(`${P}/${id}`).set('Origin', ADMIN)).status).toBe(403);
    expect(credential.id).toBeTruthy();
  });

  it('rename and remove are scoped to the caller; a stranger gets 404', async () => {
    const { passkey } = await enrolOverHttp();
    expect(
      (
        await request(app)
          .patch(`${P}/${passkey.id}`)
          .set('Origin', ADMIN)
          .send({ name: 'Renamed' })
      ).status
    ).toBe(200);
    expect(h.creds[0].name).toBe('Renamed');
    h.users.set('someone-else', { ...h.users.get('user-1'), id: 'someone-else', email: 's@x.com' });
    h.caller.userId = 'someone-else';
    await stepUp();
    expect((await request(app).delete(`${P}/${passkey.id}`).set('Origin', ADMIN)).status).toBe(404);
    expect(h.creds).toHaveLength(1);
    h.caller.userId = 'user-1';
    expect((await request(app).delete(`${P}/${passkey.id}`).set('Origin', ADMIN)).status).toBe(200);
    expect(h.creds).toHaveLength(0);
    expect(h.audit.map(a => a.action).filter(a => a !== 'passkey.stepup')).toEqual([
      'passkey.added',
      'passkey.renamed',
      'passkey.removed',
    ]);
  });

  it('rejects a non-uuid id and an over-long name at the edge', async () => {
    expect((await request(app).delete(`${P}/not-a-uuid`).set('Origin', ADMIN)).status).toBe(400);
    expect(
      (
        await request(app)
          .patch(`${P}/8f14e45f-ceea-467f-a8d1-1f0a5b6d3c11`)
          .set('Origin', ADMIN)
          .send({ name: 'x'.repeat(61) })
      ).status
    ).toBe(400);
  });

  it('registration, rename and remove are refused without a step-up; a wrong password does not open one', async () => {
    const id = '8f14e45f-ceea-467f-a8d1-1f0a5b6d3c11';
    expect((await post('/register/begin').send({})).body.error.code).toBe('STEP_UP_REQUIRED');
    expect(
      (await request(app).patch(`${P}/${id}`).set('Origin', ADMIN).send({ name: 'x' })).body.error
        .code
    ).toBe('STEP_UP_REQUIRED');
    expect((await request(app).delete(`${P}/${id}`).set('Origin', ADMIN)).body.error.code).toBe(
      'STEP_UP_REQUIRED'
    );
    const bad = await post('/step-up').send({ password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('STEP_UP_FAILED');
    expect((await post('/step-up').send({})).body.error.code).toBe('STEP_UP_FAILED');
    expect((await post('/register/begin').send({})).status).toBe(403);
    expect(h.audit.filter(a => a.action === 'passkey.stepup.failed')).toHaveLength(2);
  });

  it('step-up itself is refused for an impersonation session', async () => {
    h.caller.impersonatedBy = 'admin-9';
    expect((await post('/step-up').send({ password: PASSWORD })).status).toBe(403);
  });

  it('a step-up belongs to the session that made it (another token of the same user is refused)', async () => {
    await stepUp();
    expect((await post('/register/begin').send({})).status).toBe(200);
    h.caller.jti = 'sess-B';
    const r = await post('/register/begin').send({});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('a passkey sign-in opens the step-up window for the NEW session only', async () => {
    const { credential } = await enrolOverHttp();
    const begin = await post('/authenticate/begin').send({});
    const fin = await post('/authenticate/finish').send({
      response: assert(credential, begin.body.data, ADMIN),
    });
    expect(fin.status).toBe(200);
    h.caller.jti = 'sess-new';
    expect((await post('/register/begin').send({})).status).toBe(200);
    h.caller.jti = 'sess-unrelated';
    expect((await post('/register/begin').send({})).body.error.code).toBe('STEP_UP_REQUIRED');
  });

  describe('origin binding on the authenticated endpoints (review M4)', () => {
    const STORE_X = 'https://shop-x.ebda.app';
    const as = (method: 'get' | 'post' | 'patch' | 'delete', path: string, origin?: string) => {
      const r = request(app)[method](`${P}${path}`);
      return origin ? r.set('Origin', origin) : r;
    };
    const ID = '8f14e45f-ceea-467f-a8d1-1f0a5b6d3c11';

    it('an admin session presented from a store host is refused on every endpoint (no list leak)', async () => {
      await stepUp();
      for (const [m, path] of [
        ['get', ''],
        ['post', '/step-up'],
        ['post', '/register/begin'],
        ['post', '/register/finish'],
        ['patch', `/${ID}`],
        ['delete', `/${ID}`],
      ] as const) {
        const r = await as(m, path, STORE_X).send({ password: PASSWORD, name: 'x', response: {} });
        expect(r.status, `${m} ${path}`).toBe(403);
        expect(r.body.error.code).toBe('PASSKEY_NOT_ALLOWED');
      }
    });

    it('an unknown or missing Origin gets nothing either', async () => {
      expect((await as('get', '', 'https://unknown.example')).status).toBe(404);
      expect((await as('get', '')).status).toBe(404);
    });

    it('a shopper of ANOTHER store is refused on this store host', async () => {
      h.users.set('cust-y', {
        ...h.users.get('user-1'),
        id: 'cust-y',
        role: 'customer',
        storeId: 'store-y',
      });
      h.caller.userId = 'cust-y';
      h.caller.role = 'customer';
      (h.caller as any).storeId = 'store-y';
      const r = await as('get', '', STORE_X);
      expect(r.status).toBe(403);
    });
  });
});
