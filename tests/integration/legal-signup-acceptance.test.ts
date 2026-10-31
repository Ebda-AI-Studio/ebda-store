/**
 * Signup click-wrap over HTTP, on the real merchant-signup router bound to the strict-RLS
 * `ebda_app` login (Ruling LEGAL-4, Review Focus 3): the server refuses a signup without
 * `acceptedLegal: true` even when the UI is bypassed, and a valid signup leaves one
 * legal_acceptances row per document at its current version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_DOC_KEYS, LEGAL_POLICIES, currentLegalVersion } from '@ebda/shared';
import merchantSignupRoutes from '@api/routes/merchant-signup.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { configureIdentityClient } from '@api/lib/identity-client';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

describe.skipIf(!hasDb)('signup click-wrap (server side)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const emails: string[] = [];
  process.env.SIGNUP_MIN_FILL_MS = '0';
  process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP = '100000';

  const mkEmail = (tag: string) => {
    const e = `lsa-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`;
    emails.push(e);
    return e;
  };
  const signup = (email: string, extra: Record<string, unknown>) =>
    asApp(async () => {
      const tok = await request(app).get('/api/v1/auth/merchant/signup-token');
      return request(app)
        .post('/api/v1/auth/merchant/signup')
        .set('User-Agent', 'LegalTest/1')
        .send({
          email,
          password: 'Str0ng!Passw0rd',
          name: 'Mona Hassan',
          phone: `010${crypto.randomInt(10_000_000, 99_999_999)}`,
          formToken: tok.body.data.token,
          ...extra,
        });
    });
  const userByEmail = (email: string) =>
    owner.user.findFirst({ where: { email, storeId: null }, select: { id: true } });

  beforeAll(() => {
    // The credential is created by the identity service (accounts), which this in-process router cannot reach: stand in for its
    // createUser by echoing the id the Store chose (that id handshake is Store-side; the service's own hashing/mail is covered
    // by apps/accounts tests and tests/unit/identity-lifecycle-paths.test.ts).
    configureIdentityClient({ createUser: async i => ({ id: i.id! }) });
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/auth/merchant', merchantSignupRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    configureIdentityClient(undefined);
    await owner.user.deleteMany({ where: { email: { in: emails }, storeId: null } });
    await owner.$disconnect();
  });

  it('refuses a signup with no acceptedLegal: 400, no account', async () => {
    const email = mkEmail('missing');
    const res = await signup(email, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await userByEmail(email)).toBeNull();
  });

  it('refuses acceptedLegal: false: 400, no account', async () => {
    const email = mkEmail('false');
    const res = await signup(email, { acceptedLegal: false });
    expect(res.status).toBe(400);
    expect(await userByEmail(email)).toBeNull();
  });

  it('records one signup acceptance per document at its current version', async () => {
    const email = mkEmail('ok');
    const res = await signup(email, { acceptedLegal: true });
    expect(res.status).toBe(200);
    const user = await userByEmail(email);
    expect(user).not.toBeNull();
    const rows = await owner.legalAcceptance.findMany({
      where: { userId: user!.id },
      select: { docKey: true, version: true, source: true, userAgent: true, ip: true },
    });
    expect(rows.map(r => r.docKey).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const r of rows) {
      expect(r.version).toBe(currentLegalVersion(LEGAL_POLICIES, r.docKey as never).version);
      expect(r.source).toBe('signup');
      expect(r.userAgent).toBe('LegalTest/1');
      expect(r.ip).toBeTruthy();
    }
  });
});
