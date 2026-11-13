/**
 * Passkeys (WebAuthn) — the service, against a software authenticator. The REAL
 * @simplewebauthn/server verification runs; only Redis, the database and the store-host definers are
 * in-memory fakes. Rulings PASSKEY-1..6 (docs/plans/done/2026-10-21-passkeys.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { register, assert, type SoftCredential } from '../helpers/software-authenticator';

const SID = 'sess-X';
const ADMIN_ORIGIN = 'https://admin.ebda.app';
const STORE_A = 'https://shop-a.ebda.app';
const STORE_B = 'https://shop-b.ebda.app';
const STORE_A_CUSTOM = 'https://www.shop-a.example';

type Row = Record<string, any>;
const h = vi.hoisted(() => {
  const state = {
    redis: new Map<string, string>(),
    redisUp: true,
    setexCalls: [] as Array<{ key: string; ttl: number }>,
    users: new Map<string, Row>(),
    creds: [] as Row[],
    stores: new Map<string, string>(), // host-ish key -> store id
    fails: new Map<string, number>(), // shared login lockout counters
    mails: [] as any[],
    mailFails: false,
    revoked: [] as string[],
  };
  return { state };
});

vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () =>
      h.state.redisUp
        ? {
            setex: async (k: string, ttl: number, v: string) => {
              h.state.setexCalls.push({ key: k, ttl });
              h.state.redis.set(k, v);
              return 'OK';
            },
            get: async (k: string) => h.state.redis.get(k) ?? null,
            del: async (k: string) => (h.state.redis.delete(k) ? 1 : 0),
          }
        : null,
  },
}));

vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: async (k: string) => ({
      locked: (h.state.fails.get(k) ?? 0) >= 5,
      remainingMs: 60000,
    }),
    recordFailedAttempt: async (k: string) => {
      const n = (h.state.fails.get(k) ?? 0) + 1;
      h.state.fails.set(k, n);
      return { locked: n >= 5, attemptsRemaining: Math.max(0, 5 - n), lockoutDurationMs: 60000 };
    },
    recordSuccessfulLogin: async (k: string) => void h.state.fails.delete(k),
  },
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { revokeAllSessions: async (id: string) => void h.state.revoked.push(id) },
}));
vi.mock('@api/services/platform-mailer', () => ({
  sendPasskeyNoticeEmail: async (d: any) => {
    if (h.state.mailFails) throw new Error('resend down');
    h.state.mails.push({ ...d, via: 'platform' });
  },
}));
// A shopper's notice comes from the STORE's sender identity (review M8), not from Ebda.
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendPasskeyNotice: async (storeId: string, d: any) => {
      if (h.state.mailFails) throw new Error('resend down');
      h.state.mails.push({ ...d, via: 'store', storeId });
    },
  },
}));

vi.mock('@api/lib/definer', () => ({
  lookupStore: async (m: { slug?: string; domain?: string }) => {
    const id = h.state.stores.get(m.slug ?? m.domain ?? '');
    return id ? { id, status: 'active' } : null;
  },
  passkeyLookup: async (credentialId: string) => {
    const c = h.state.creds.find(x => x.credentialId === credentialId);
    return c
      ? {
          id: c.id,
          userId: c.userId,
          publicKey: c.publicKey,
          counter: c.counter,
          transports: c.transports,
          rpId: c.rpId,
        }
      : null;
  },
}));

vi.mock('@ebda/database', () => {
  const tx = {
    user: {
      findUnique: async ({ where }: any) => h.state.users.get(where.id) ?? null,
    },
    passkeyCredential: {
      findMany: async ({ where }: any) =>
        h.state.creds.filter(c => c.userId === where.userId).map(c => ({ ...c })),
      count: async ({ where }: any) => h.state.creds.filter(c => c.userId === where.userId).length,
      create: async ({ data }: any) => {
        if (h.state.creds.some(c => c.credentialId === data.credentialId)) {
          const e: any = new Error('unique');
          e.code = 'P2002';
          throw e;
        }
        const row = {
          id: `pk-${h.state.creds.length + 1}`,
          createdAt: new Date(),
          lastUsedAt: null,
          ...data,
        };
        h.state.creds.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        const hits = h.state.creds.filter(
          c =>
            c.id === where.id &&
            c.userId === where.userId &&
            (where.counter?.lt === undefined || c.counter < where.counter.lt)
        );
        hits.forEach(c => Object.assign(c, data));
        return { count: hits.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = h.state.creds.length;
        h.state.creds = h.state.creds.filter(
          c => !(c.id === where.id && c.userId === where.userId)
        );
        return { count: before - h.state.creds.length };
      },
    },
  };
  return { withUser: async (_id: string, fn: any) => fn(tx), prisma: {} };
});

vi.mock('@api/config', () => ({
  config: { adminUrl: 'https://admin.ebda.app', webUrl: 'https://ebda.app', nodeEnv: 'production' },
}));
vi.mock('@api/services/encryption.service', () => ({
  encryption: { decrypt: (s: string) => s.replace(/^enc:/, '') },
}));

import { PasskeyService, resolvePasskeyContext } from '@api/services/passkey.service';

const PASSWORD = 'Correct-pw-1';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const user = (over: Row = {}): Row => ({
  id: 'user-1',
  passwordHash: PASSWORD_HASH,
  language: 'en',
  email: 'm@x.com',
  firstName: 'Mona',
  lastName: 'S',
  role: 'store_admin',
  storeId: null,
  status: 'active',
  deletedAt: null,
  emailVerified: true,
  tokenVersion: 0,
  mfaEnabled: false,
  mfaSecret: null,
  ...over,
});

beforeEach(() => {
  h.state.redis.clear();
  h.state.redisUp = true;
  h.state.setexCalls = [];
  h.state.users = new Map();
  h.state.creds = [];
  h.state.fails = new Map();
  h.state.mails = [];
  h.state.mailFails = false;
  h.state.revoked = [];
  h.state.stores = new Map([
    ['shop-a', 'store-a'],
    ['shop-b', 'store-b'],
    ['www.shop-a.example', 'store-a'],
    ['shop-a.example', 'store-a'],
  ]);
  h.state.users.set('user-1', user());
  h.state.users.set(
    'cust-a',
    user({ id: 'cust-a', role: 'customer', storeId: 'store-a', email: 'c@a.com' })
  );
  h.state.users.set(
    'cust-b',
    user({ id: 'cust-b', role: 'customer', storeId: 'store-b', email: 'c@b.com' })
  );
  h.state.users.set('root', user({ id: 'root', role: 'super_admin', email: 'root@x.com' }));
});

/** Register a passkey for `userId` from `origin` and return the software credential. */
async function enrol(userId: string, origin: string, name = 'My phone'): Promise<SoftCredential> {
  await PasskeyService.markStepUp(userId, SID);
  const options = await PasskeyService.beginRegistration({ userId, sessionId: SID }, origin, {});
  const { credential, response } = register(options as any, origin);
  await PasskeyService.finishRegistration({ userId, sessionId: SID }, origin, { response, name });
  return credential;
}

async function signIn(
  origin: string,
  cred: SoftCredential,
  over: Parameters<typeof assert>[3] = {}
) {
  const options = await PasskeyService.beginAuthentication(origin);
  const response = assert(cred, options as any, origin, over);
  return {
    options,
    response,
    result: PasskeyService.finishAuthentication(origin, response as any),
  };
}

describe('resolvePasskeyContext (RP ID strategy, PASSKEY-3)', () => {
  it('admin origin -> admin surface, RP ID = the admin host', async () => {
    expect(await resolvePasskeyContext(ADMIN_ORIGIN)).toMatchObject({
      surface: 'admin',
      rpId: 'admin.ebda.app',
      origin: ADMIN_ORIGIN,
      storeId: null,
    });
  });
  it('store subdomain -> storefront, RP ID = that store host, scoped to its store', async () => {
    expect(await resolvePasskeyContext(STORE_A)).toMatchObject({
      surface: 'storefront',
      rpId: 'shop-a.ebda.app',
      storeId: 'store-a',
    });
  });
  it('verified custom domain -> storefront with the custom host as RP ID', async () => {
    expect(await resolvePasskeyContext(STORE_A_CUSTOM)).toMatchObject({
      surface: 'storefront',
      rpId: 'www.shop-a.example',
      storeId: 'store-a',
    });
  });
  it.each([
    undefined,
    '',
    'null',
    'not a url',
    'https://unknown.ebda.app',
    'https://evil.example',
    'https://ebda.app',
  ])('refuses %s (no default-to-first)', async origin => {
    await expect(resolvePasskeyContext(origin as any)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PASSKEY_NOT_AVAILABLE',
    });
  });
});

describe('registration', () => {
  beforeEach(async () => {
    for (const id of ['user-1', 'user-2', 'cust-a', 'cust-b', 'root'])
      await PasskeyService.markStepUp(id, SID);
  });

  it('registers a merchant passkey: UV required, discoverable, challenge stored single-use with TTL >= 120s', async () => {
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    expect(options.rp.id).toBe('admin.ebda.app');
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');
    const chal = h.state.setexCalls.filter(c => c.key.startsWith('passkey:ch:'));
    expect(chal).toHaveLength(1);
    expect(chal[0].ttl).toBeGreaterThanOrEqual(120);
    // The stored key is a hash, never the raw challenge.
    expect(chal[0].key).not.toContain(options.challenge);

    const { response } = register(options, ADMIN_ORIGIN);
    const item = await PasskeyService.finishRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {
        response,
        name: 'Work laptop',
      }
    );
    expect(item).toMatchObject({ name: 'Work laptop', needsReenrol: false });
    expect(h.state.creds).toHaveLength(1);
    expect(h.state.creds[0]).toMatchObject({ userId: 'user-1', rpId: 'admin.ebda.app' });
    // Only the PUBLIC key is persisted.
    expect(Object.keys(h.state.creds[0])).not.toContain('privateKey');
  });

  it('fails closed when the challenge store is down', async () => {
    h.state.redisUp = false;
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('rejects a registration whose clientDataJSON origin is not the one the challenge was issued for', async () => {
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    const { response } = register(options, ADMIN_ORIGIN, {
      clientDataOrigin: 'https://evil.example',
    });
    await expect(
      PasskeyService.finishRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {
        response,
        name: 'x',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'PASSKEY_REGISTRATION_FAILED' });
    expect(h.state.creds).toHaveLength(0);
  });

  it('rejects a finish that arrives from a different origin than begin (RP ID / origin mismatch)', async () => {
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'cust-a', sessionId: SID },
      STORE_A,
      {}
    );
    const { response } = register(options, STORE_A);
    await expect(
      PasskeyService.finishRegistration({ userId: 'cust-a', sessionId: SID }, STORE_B, {
        response,
        name: 'x',
      })
    ).rejects.toMatchObject({ code: 'PASSKEY_REGISTRATION_FAILED' });
    expect(h.state.creds).toHaveLength(0);
  });

  it('rejects an authenticator that did not verify the user (UV required)', async () => {
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    const { response } = register(options, ADMIN_ORIGIN, { userVerified: false });
    await expect(
      PasskeyService.finishRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {
        response,
        name: 'x',
      })
    ).rejects.toMatchObject({ code: 'PASSKEY_REGISTRATION_FAILED' });
  });

  it('a challenge is single-use: replaying the same registration response is rejected', async () => {
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    const { response } = register(options, ADMIN_ORIGIN);
    await PasskeyService.finishRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {
      response,
      name: 'a',
    });
    await expect(
      PasskeyService.finishRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {
        response,
        name: 'a',
      })
    ).rejects.toMatchObject({ code: 'PASSKEY_REGISTRATION_FAILED' });
    expect(h.state.creds).toHaveLength(1);
  });

  it('a challenge issued to one user cannot be finished by another', async () => {
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    const { response } = register(options, ADMIN_ORIGIN);
    h.state.users.set('user-2', user({ id: 'user-2', email: 'two@x.com' }));
    await expect(
      PasskeyService.finishRegistration({ userId: 'user-2', sessionId: SID }, ADMIN_ORIGIN, {
        response,
        name: 'a',
      })
    ).rejects.toMatchObject({ code: 'PASSKEY_REGISTRATION_FAILED' });
  });

  it('super_admin is excluded (PASSKEY-5); a customer cannot enrol on the admin surface and a merchant not on a storefront', async () => {
    await expect(
      PasskeyService.beginRegistration({ userId: 'root', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PASSKEY_NOT_ALLOWED',
    });
    await expect(
      PasskeyService.beginRegistration({ userId: 'cust-a', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      code: 'PASSKEY_NOT_ALLOWED',
    });
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, STORE_A, {})
    ).rejects.toMatchObject({
      code: 'PASSKEY_NOT_ALLOWED',
    });
  });

  it("a shopper cannot enrol on another store's host", async () => {
    await expect(
      PasskeyService.beginRegistration({ userId: 'cust-a', sessionId: SID }, STORE_B, {})
    ).rejects.toMatchObject({
      code: 'PASSKEY_NOT_ALLOWED',
    });
  });

  it('caps passkeys per account', async () => {
    for (let i = 0; i < 10; i++) {
      h.state.creds.push({
        id: `p${i}`,
        userId: 'user-1',
        credentialId: `c${i}`,
        rpId: 'admin.ebda.app',
        transports: [],
      });
    }
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASSKEY_LIMIT',
    });
  });

  it('excludes already-registered credentials of this host from the creation options', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    expect(options.excludeCredentials.map((c: any) => c.id)).toEqual([cred.id]);
  });
});

describe('authentication (discoverable, no email)', () => {
  it('signs a merchant in with a passkey and returns the user to mint a session for', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const { options, result } = await signIn(ADMIN_ORIGIN, cred);
    expect((options as any).userVerification).toBe('required');
    expect((options as any).allowCredentials ?? []).toEqual([]);
    const out = await result;
    expect(out.user.id).toBe('user-1');
    expect(h.state.creds[0].counter).toBe(1);
    expect(h.state.creds[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('signs a shopper in on their own store, via the slug host and via the custom domain after re-enrol', async () => {
    const cred = await enrol('cust-a', STORE_A);
    expect((await (await signIn(STORE_A, cred)).result).user.id).toBe('cust-a');
    // Same credential on the custom domain: different RP ID => refused (custom-domain switch invalidates it).
    const onCustom = await signIn(STORE_A_CUSTOM, cred);
    await expect(onCustom.result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
    // A fresh enrolment on the custom host works.
    const fresh = await enrol('cust-a', STORE_A_CUSTOM, 'Face ID');
    expect((await (await signIn(STORE_A_CUSTOM, fresh)).result).user.id).toBe('cust-a');
  });

  it('rejects a replayed assertion (single-use challenge)', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const { response, result } = await signIn(ADMIN_ORIGIN, cred);
    await result;
    await expect(
      PasskeyService.finishAuthentication(ADMIN_ORIGIN, response as any)
    ).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('rejects an assertion carrying a different origin in clientDataJSON', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const { result } = await signIn(ADMIN_ORIGIN, cred, {
      clientDataOrigin: 'https://evil.example',
    });
    await expect(result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
  });

  it('rejects a finish from a different origin than begin', async () => {
    const cred = await enrol('cust-a', STORE_A);
    const options = await PasskeyService.beginAuthentication(STORE_A);
    const response = assert(cred, options as any, STORE_A);
    await expect(
      PasskeyService.finishAuthentication(STORE_B, response as any)
    ).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it("a credential from store A cannot sign in on store B's host (cross-store)", async () => {
    const cred = await enrol('cust-a', STORE_A);
    // Even if the authenticator were tricked into signing for B's origin with A's key: RP ID + store differ.
    const options = await PasskeyService.beginAuthentication(STORE_B);
    const forged = { ...cred, rpId: 'shop-b.ebda.app' };
    const response = assert(forged, options as any, STORE_B);
    await expect(
      PasskeyService.finishAuthentication(STORE_B, response as any)
    ).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('a shopper credential cannot sign in on the admin surface and a merchant credential not on a storefront', async () => {
    const shopper = await enrol('cust-a', STORE_A);
    const merchant = await enrol('user-1', ADMIN_ORIGIN);
    const a = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    await expect(
      PasskeyService.finishAuthentication(
        ADMIN_ORIGIN,
        assert({ ...shopper, rpId: 'admin.ebda.app' }, a as any, ADMIN_ORIGIN) as any
      )
    ).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
    const s = await PasskeyService.beginAuthentication(STORE_A);
    await expect(
      PasskeyService.finishAuthentication(
        STORE_A,
        assert({ ...merchant, rpId: 'shop-a.ebda.app' }, s as any, STORE_A) as any
      )
    ).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
  });

  it('RP ID binding holds on its own: a same-store credential minted for another host is refused', async () => {
    const cred = await enrol('cust-a', STORE_A);
    // The authenticator (hypothetically) signs for the custom host with the same key: store matches, host does not.
    const options = await PasskeyService.beginAuthentication(STORE_A_CUSTOM);
    const response = assert(
      { ...cred, rpId: 'www.shop-a.example' },
      options as any,
      STORE_A_CUSTOM
    );
    await expect(
      PasskeyService.finishAuthentication(STORE_A_CUSTOM, response as any)
    ).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('a challenge is consumed even for counter-0 authenticators (replay of a synced-passkey assertion)', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const { response, result } = await signIn(ADMIN_ORIGIN, cred, { counter: 0 });
    await result;
    await expect(
      PasskeyService.finishAuthentication(ADMIN_ORIGIN, response as any)
    ).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('two racing assertions with the same sign count cannot both succeed', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const o1: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    const o2: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    const r1 = assert(cred, o1, ADMIN_ORIGIN, { counter: 7 });
    const r2 = assert(cred, o2, ADMIN_ORIGIN, { counter: 7 });
    const settled = await Promise.allSettled([
      PasskeyService.finishAuthentication(ADMIN_ORIGIN, r1 as any),
      PasskeyService.finishAuthentication(ADMIN_ORIGIN, r2 as any),
    ]);
    expect(settled.filter(s => s.status === 'fulfilled')).toHaveLength(1);
  });

  it('a deleted credential cannot sign in', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const [row] = await PasskeyService.list('user-1', ADMIN_ORIGIN);
    await PasskeyService.remove({ userId: 'user-1', sessionId: SID }, row.id);
    const { result } = await signIn(ADMIN_ORIGIN, cred);
    await expect(result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
  });

  it('refuses a suspended or soft-deleted account', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    h.state.users.set('user-1', user({ status: 'suspended' }));
    await expect((await signIn(ADMIN_ORIGIN, cred)).result).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
    h.state.users.set('user-1', user({ deletedAt: new Date() }));
    await expect((await signIn(ADMIN_ORIGIN, cred)).result).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('refuses a super_admin even if a credential row exists', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    h.state.users.set('user-1', user({ role: 'super_admin' }));
    await expect((await signIn(ADMIN_ORIGIN, cred)).result).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('requires user verification', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const { result } = await signIn(ADMIN_ORIGIN, cred, { userVerified: false });
    await expect(result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
  });

  it('detects a cloned authenticator (non-increasing sign count) and does not log in', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    await (
      await signIn(ADMIN_ORIGIN, cred, { counter: 5 })
    ).result;
    const { result } = await signIn(ADMIN_ORIGIN, cred, { counter: 3 });
    await expect(result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
    expect(h.state.creds[0].counter).toBe(5);
  });

  it('accepts authenticators that always report counter 0 (synced passkeys)', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    expect((await (await signIn(ADMIN_ORIGIN, cred, { counter: 0 })).result).user.id).toBe(
      'user-1'
    );
    expect((await (await signIn(ADMIN_ORIGIN, cred, { counter: 0 })).result).user.id).toBe(
      'user-1'
    );
  });

  it('a mismatched userHandle is rejected', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const { result } = await signIn(ADMIN_ORIGIN, cred, {
      userHandle: Buffer.from('someone-else').toString('base64url'),
    });
    await expect(result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
  });

  it('is enumeration-safe: unknown credential, bad signature and expired challenge all fail identically', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const failures: Array<{ statusCode: number; code: string; message: string }> = [];
    const grab = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e: any) {
        failures.push({ statusCode: e.statusCode, code: e.code, message: e.message });
      }
    };
    // 1. unknown credential
    const o1 = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    const stranger = register(
      { challenge: 'x', rp: { id: 'admin.ebda.app' }, user: { id: 'u' } },
      ADMIN_ORIGIN
    ).credential;
    await grab(
      PasskeyService.finishAuthentication(
        ADMIN_ORIGIN,
        assert(stranger, o1 as any, ADMIN_ORIGIN) as any
      )
    );
    // 2. known credential, tampered signature
    const o2 = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    const bad: any = assert(cred, o2 as any, ADMIN_ORIGIN);
    bad.response.signature = Buffer.alloc(70, 1).toString('base64url');
    await grab(PasskeyService.finishAuthentication(ADMIN_ORIGIN, bad));
    // 3. challenge that was never issued
    await grab(
      PasskeyService.finishAuthentication(
        ADMIN_ORIGIN,
        assert(cred, { challenge: Buffer.alloc(32, 7).toString('base64url') }, ADMIN_ORIGIN) as any
      )
    );
    expect(failures).toHaveLength(3);
    expect(new Set(failures.map(f => JSON.stringify(f))).size).toBe(1);
    expect(failures[0]).toMatchObject({ statusCode: 401, code: 'PASSKEY_AUTH_FAILED' });
  });

  it('begin is identical for any caller: it never looks at an email or account', async () => {
    const a: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    expect(Object.keys(a).sort()).toEqual(
      Object.keys(await PasskeyService.beginAuthentication(ADMIN_ORIGIN)).sort()
    );
    expect(a.allowCredentials ?? []).toEqual([]);
  });
});

describe('management', () => {
  beforeEach(async () => {
    for (const id of ['user-1', 'cust-a', 'cust-b']) await PasskeyService.markStepUp(id, SID);
  });

  it('lists, renames and removes only the caller’s own passkeys; flags a host change as needing re-enrol', async () => {
    await enrol('cust-a', STORE_A, 'iPhone');
    const items = await PasskeyService.list('cust-a', STORE_A);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'iPhone', needsReenrol: false });
    expect(Object.keys(items[0])).not.toContain('publicKey');
    expect((await PasskeyService.list('cust-a', STORE_A_CUSTOM))[0].needsReenrol).toBe(true);

    await expect(
      PasskeyService.rename({ userId: 'cust-b', sessionId: SID }, items[0].id, 'mine now')
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      PasskeyService.remove({ userId: 'cust-b', sessionId: SID }, items[0].id)
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await PasskeyService.rename({ userId: 'cust-a', sessionId: SID }, items[0].id, 'Face ID');
    expect(h.state.creds[0].name).toBe('Face ID');
    await PasskeyService.remove({ userId: 'cust-a', sessionId: SID }, items[0].id);
    expect(h.state.creds).toHaveLength(0);
  });
});

describe('step-up: register, rename and remove need a recent re-auth (PASSKEY-7)', () => {
  const stepupTtls = () => h.state.setexCalls.filter(c => c.key.startsWith('passkey:stepup:'));

  it('refuses to add, rename or remove on a bare session', async () => {
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'STEP_UP_REQUIRED',
    });
    h.state.creds.push({
      id: 'p1',
      userId: 'user-1',
      credentialId: 'c1',
      rpId: 'admin.ebda.app',
      transports: [],
      name: 'mine',
    });
    await expect(
      PasskeyService.rename({ userId: 'user-1', sessionId: SID }, 'p1', 'x')
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(
      PasskeyService.remove({ userId: 'user-1', sessionId: SID }, 'p1')
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(h.state.creds).toHaveLength(1);
    expect(h.state.revoked).toEqual([]);
  });

  it('a wrong password does not unlock anything', async () => {
    await expect(PasskeyService.stepUp('user-1', SID, { password: 'nope' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'STEP_UP_FAILED',
    });
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  it('the right password unlocks it for a short, server-held window (120s..300s)', async () => {
    await PasskeyService.stepUp('user-1', SID, { password: PASSWORD });
    expect(stepupTtls()).toHaveLength(1);
    expect(stepupTtls()[0].ttl).toBeGreaterThanOrEqual(120);
    expect(stepupTtls()[0].ttl).toBeLessThanOrEqual(300);
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {})
    ).resolves.toBeTruthy();
  });

  it('with TOTP on, the password alone is not enough; password + a current code is', async () => {
    h.state.users.set('user-1', user({ mfaEnabled: true, mfaSecret: `enc:${TOTP_SECRET}` }));
    await expect(
      PasskeyService.stepUp('user-1', SID, { password: PASSWORD })
    ).rejects.toMatchObject({
      code: 'STEP_UP_FAILED',
    });
    await expect(
      PasskeyService.stepUp('user-1', SID, { password: PASSWORD, code: '000000' })
    ).rejects.toMatchObject({
      code: 'STEP_UP_FAILED',
    });
    await PasskeyService.stepUp('user-1', SID, {
      password: PASSWORD,
      code: authenticator.generate(TOTP_SECRET),
    });
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {})
    ).resolves.toBeTruthy();
  });

  it('expiry is enforced server-side, including between begin and finish', async () => {
    await PasskeyService.stepUp('user-1', SID, { password: PASSWORD });
    const options: any = await PasskeyService.beginRegistration(
      { userId: 'user-1', sessionId: SID },
      ADMIN_ORIGIN,
      {}
    );
    for (const k of [...h.state.redis.keys()])
      if (k.startsWith('passkey:stepup:')) h.state.redis.delete(k);
    const { response } = register(options, ADMIN_ORIGIN);
    await expect(
      PasskeyService.finishRegistration({ userId: 'user-1', sessionId: SID }, ADMIN_ORIGIN, {
        response,
        name: 'x',
      })
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(h.state.creds).toHaveLength(0);
  });

  it('a step-up from session X does not authorize session Y of the same user (PASSKEY-12)', async () => {
    await PasskeyService.stepUp('user-1', 'sess-X', { password: PASSWORD });
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: 'sess-Y' }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    h.state.creds.push({
      id: 'p1',
      userId: 'user-1',
      credentialId: 'c1',
      rpId: 'admin.ebda.app',
      transports: [],
      name: 'm',
    });
    await expect(
      PasskeyService.remove({ userId: 'user-1', sessionId: 'sess-Y' }, 'p1')
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(
      PasskeyService.rename({ userId: 'user-1', sessionId: 'sess-Y' }, 'p1', 'x')
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(h.state.creds).toHaveLength(1);
  });

  it('a session with no id can never hold a step-up', async () => {
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-1', sessionId: undefined }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('a proof stored for user U cannot be replayed for user V even with the same session id', async () => {
    await PasskeyService.stepUp('user-1', 'sess-X', { password: PASSWORD });
    h.state.users.set('user-2', user({ id: 'user-2', email: 'two@x.com' }));
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-2', sessionId: 'sess-X' }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // Even a planted key for V's slot holding U's id is refused (the value is checked, not just its presence).
    const k = [...h.state.redis.keys()].find(x => x.startsWith('passkey:stepup:user-1:'))!;
    h.state.redis.set(k.replace('user-1', 'user-2'), 'user-1');
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-2', sessionId: 'sess-X' }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('the proof lives only server-side: the key never contains the raw session id', async () => {
    await PasskeyService.stepUp('user-1', 'sess-X', { password: PASSWORD });
    expect(stepupTtls()[0].key).not.toContain('sess-X');
  });

  it('a step-up is per user', async () => {
    await PasskeyService.stepUp('user-1', SID, { password: PASSWORD });
    h.state.users.set('user-2', user({ id: 'user-2', email: 'two@x.com' }));
    await expect(
      PasskeyService.beginRegistration({ userId: 'user-2', sessionId: SID }, ADMIN_ORIGIN, {})
    ).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  it('wrong step-up guesses feed the SAME lockout counter as password login', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(PasskeyService.stepUp('user-1', SID, { password: 'bad' })).rejects.toBeTruthy();
    }
    expect(h.state.fails.get('m@x.com')).toBe(5);
    await expect(
      PasskeyService.stepUp('user-1', SID, { password: PASSWORD })
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'ACCOUNT_LOCKED',
    });
  });
});

describe('login gate parity with password login (PASSKEY-8)', () => {
  it('failed passkey attempts for an identified account feed the shared lockout counter, then a VALID assertion is refused', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    for (let i = 0; i < 5; i++) {
      const o: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
      const bad: any = assert(cred, o, ADMIN_ORIGIN);
      bad.response.signature = Buffer.alloc(70, 1).toString('base64url');
      await expect(
        PasskeyService.finishAuthentication(ADMIN_ORIGIN, bad, undefined, { ip: '1.2.3.4' })
      ).rejects.toMatchObject({
        code: 'PASSKEY_AUTH_FAILED',
      });
    }
    expect(h.state.fails.get('m@x.com')).toBe(5);
    const { result } = await signIn(ADMIN_ORIGIN, cred);
    await expect(result).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
  });

  it('password-side failures lock passkey sign-in too (no alternating methods to dodge lockout)', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    h.state.fails.set('m@x.com', 5);
    const reasons: string[] = [];
    const o: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    await expect(
      PasskeyService.finishAuthentication(ADMIN_ORIGIN, assert(cred, o, ADMIN_ORIGIN) as any, r =>
        reasons.push(r)
      )
    ).rejects.toMatchObject({ statusCode: 401, code: 'PASSKEY_AUTH_FAILED' });
    expect(reasons).toEqual(['locked']);
  });

  it('a shopper lockout key is store-scoped exactly like password login', async () => {
    const cred = await enrol('cust-a', STORE_A);
    const o: any = await PasskeyService.beginAuthentication(STORE_A);
    const bad: any = assert(cred, o, STORE_A);
    bad.response.signature = Buffer.alloc(70, 2).toString('base64url');
    await expect(PasskeyService.finishAuthentication(STORE_A, bad)).rejects.toBeTruthy();
    expect(h.state.fails.get('store-a:c@a.com')).toBe(1);
    expect(h.state.fails.get('c@a.com')).toBeUndefined();
  });

  it('a successful passkey sign-in clears the counter, like a successful password login', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    h.state.fails.set('m@x.com', 3);
    await (
      await signIn(ADMIN_ORIGIN, cred)
    ).result;
    expect(h.state.fails.get('m@x.com')).toBeUndefined();
  });

  it('the failure callback learns who it was (for the audit row) without telling the client', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    h.state.users.set('user-1', user({ status: 'suspended' }));
    const seen: Array<[string, string | undefined]> = [];
    const o: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    await expect(
      PasskeyService.finishAuthentication(
        ADMIN_ORIGIN,
        assert(cred, o, ADMIN_ORIGIN) as any,
        (r, uid) => seen.push([r, uid])
      )
    ).rejects.toMatchObject({ code: 'PASSKEY_AUTH_FAILED' });
    expect(seen).toEqual([['account', 'user-1']]);
  });
});

describe('notices and revocation (PASSKEY-9)', () => {
  beforeEach(async () => {
    await PasskeyService.markStepUp('user-1', SID);
  });

  it('emails the account on every passkey added and removed', async () => {
    await enrol('user-1', ADMIN_ORIGIN, 'Work laptop');
    expect(h.state.mails).toHaveLength(1);
    expect(h.state.mails[0]).toMatchObject({
      kind: 'added',
      email: 'm@x.com',
      passkeyName: 'Work laptop',
    });
    const [row] = await PasskeyService.list('user-1', ADMIN_ORIGIN);
    await PasskeyService.remove({ userId: 'user-1', sessionId: SID }, row.id);
    expect(h.state.mails).toHaveLength(2);
    expect(h.state.mails[1]).toMatchObject({
      kind: 'removed',
      email: 'm@x.com',
      passkeyName: 'Work laptop',
    });
  });

  it('a mail outage never fails or rolls back the change', async () => {
    h.state.mailFails = true;
    await enrol('user-1', ADMIN_ORIGIN);
    expect(h.state.creds).toHaveLength(1);
    await PasskeyService.remove({ userId: 'user-1', sessionId: SID }, h.state.creds[0].id);
    expect(h.state.creds).toHaveLength(0);
  });

  it('removing a passkey signs the account out everywhere (sessions and refresh tokens)', async () => {
    await enrol('user-1', ADMIN_ORIGIN);
    await PasskeyService.remove({ userId: 'user-1', sessionId: SID }, h.state.creds[0].id);
    expect(h.state.revoked).toEqual(['user-1']);
  });

  it('a failed removal (not yours) revokes nothing and mails nothing', async () => {
    await enrol('user-1', ADMIN_ORIGIN);
    h.state.mails = [];
    await PasskeyService.markStepUp('user-2', SID);
    await expect(
      PasskeyService.remove({ userId: 'user-2', sessionId: SID }, h.state.creds[0].id)
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.state.revoked).toEqual([]);
    expect(h.state.mails).toEqual([]);
  });

  it('deleting a credential blocks an assertion whose challenge was issued BEFORE the delete', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    const o: any = await PasskeyService.beginAuthentication(ADMIN_ORIGIN);
    const response = assert(cred, o, ADMIN_ORIGIN);
    await PasskeyService.remove({ userId: 'user-1', sessionId: SID }, h.state.creds[0].id);
    await expect(
      PasskeyService.finishAuthentication(ADMIN_ORIGIN, response as any)
    ).rejects.toMatchObject({
      code: 'PASSKEY_AUTH_FAILED',
    });
  });

  it('a passkey session is minted at the CURRENT token version, so every tv bump (password change, suspend, sign-out-all) kills it', async () => {
    const cred = await enrol('user-1', ADMIN_ORIGIN);
    h.state.users.set('user-1', user({ tokenVersion: 7 }));
    expect((await (await signIn(ADMIN_ORIGIN, cred)).result).user.tokenVersion).toBe(7);
  });

  it('a merchant notice comes from the platform sender; a shopper notice from THEIR STORE (review M8)', async () => {
    await enrol('user-1', ADMIN_ORIGIN, 'Work laptop');
    expect(h.state.mails[0]).toMatchObject({ via: 'platform', email: 'm@x.com' });
    await enrol('cust-a', STORE_A, 'My iPhone');
    expect(h.state.mails[1]).toMatchObject({
      via: 'store',
      storeId: 'store-a',
      email: 'c@a.com',
      kind: 'added',
      passkeyName: 'My iPhone',
    });
    await PasskeyService.remove({ userId: 'cust-a', sessionId: SID }, h.state.creds[1].id);
    expect(h.state.mails[2]).toMatchObject({ via: 'store', storeId: 'store-a', kind: 'removed' });
  });
});
