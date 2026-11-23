import { env } from 'cloudflare:test';
import { createApp } from '../src/app';
import { hashPassword } from '../src/password';
import { iso } from '../src/util';
import { createLocalJWKSet, jwtVerify } from 'jose';

const app = createApp();

export interface Fakes {
  stores: Array<{ id: string; role: 'owner' | 'staff' }>;
  notices: Array<{ to: string; kind: string; factor?: string; workspaceName?: string }>;
  mails: Array<{ to: string; kind: string; code: string; ttlMinutes?: number; storeName?: string }>;
  directoryDown: boolean;
  /** Store ids the directory reports as deleted. */
  deletedStores: Set<string>;
  /** Store ids the directory reports as suspended (they exist, but integrations stop). */
  suspendedStores: Set<string>;
  /** Per-test overrides merged over the worker env (e.g. MFA_KEY / MFA_KEY_PREV during a rotation). */
  envOverride: Record<string, unknown>;
  /** The ebda-wa `PlatformOtp.sendCode` fake. `bound: false` (the default) = the binding is ABSENT; `enabled` is the WHATSAPP_OTP_ENABLED flag (default off, as in production). */
  whatsapp: {
    bound: boolean;
    enabled: boolean;
    calls: Array<{ phone: string; code: string; args: unknown[] }>;
    result: { ok: true } | { ok: false; reason: string };
    throws: boolean;
  };
}
export const fakes: Fakes = {
  stores: [],
  notices: [],
  mails: [],
  directoryDown: false,
  deletedStores: new Set<string>(),
  suspendedStores: new Set<string>(),
  envOverride: {},
  whatsapp: { bound: false, enabled: false, calls: [], result: { ok: true }, throws: false },
};

export const testEnv = (): Cloudflare.Env =>
  ({
    ...env,
    ...fakes.envOverride,
    ISSUER: 'https://accounts.ebda.app',
    PRODUCTS: 'store,whatsapp,crm,erp',
    PASSKEY_ORIGINS: 'https://store.ebda.app,https://orders.ebda.app',
    STORE_DIRECTORY: {
      storesForUser: async () => {
        if (fakes.directoryDown) throw new Error('down');
        return fakes.stores;
      },
      storeExists: async (id: string) => {
        if (fakes.directoryDown) throw new Error('down');
        return !fakes.deletedStores.has(id);
      },
      storeActive: async (id: string) => {
        if (fakes.directoryDown) throw new Error('down');
        return !fakes.deletedStores.has(id) && !fakes.suspendedStores.has(id);
      },
    },
    WHATSAPP_OTP_ENABLED: fakes.whatsapp.enabled ? 'true' : 'false',
    ...(fakes.whatsapp.bound
      ? {
          WHATSAPP_OTP: {
            sendCode: async (...args: unknown[]) => {
              fakes.whatsapp.calls.push({ phone: String(args[0]), code: String(args[1]), args });
              if (fakes.whatsapp.throws) throw new Error('ebda-wa down');
              return fakes.whatsapp.result;
            },
          },
        }
      : { WHATSAPP_OTP: undefined }),
    MAILER: {
      sendNotice: async (m: {
        to: string;
        kind: string;
        factor?: string;
        workspaceName?: string;
      }) => {
        fakes.notices.push({
          to: m.to,
          kind: m.kind,
          factor: m.factor,
          workspaceName: m.workspaceName,
        });
      },
      sendCode: async (m: {
        to: string;
        kind: string;
        code: string;
        ttlMinutes?: number;
        storeName?: string;
      }) => {
        fakes.mails.push({
          to: m.to,
          kind: m.kind,
          code: m.code,
          ttlMinutes: m.ttlMinutes,
          storeName: m.storeName,
        });
      },
    },
  }) as unknown as Cloudflare.Env;

const BASE = 'https://accounts.ebda.app';

const rnd = () => Math.floor(Math.random() * 250);

export async function call(
  path: string,
  init: RequestInit & {
    cookie?: string;
    bearer?: string;
    json?: unknown;
    /** application/x-www-form-urlencoded body (the OAuth token endpoint). */
    form?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    // a fresh client IP per call unless the test pins one: per-IP budgets are exercised explicitly in hardening.test.ts
    'cf-connecting-ip': `10.${rnd()}.${rnd()}.${rnd()}`,
    ...(init.headers ?? {}),
  };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (init.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const req = new Request(BASE + path, {
    method: init.method ?? (init.json !== undefined || init.form !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
  });
  const pending: Promise<unknown>[] = [];
  const res = await app.fetch(req, testEnv(), {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext);
  // background work (mail) finishes before the test inspects it
  await Promise.allSettled(pending);
  return res;
}

export const cookieOf = (res: Response): string => {
  const raw = res.headers.getSetCookie().find(c => c.startsWith('__Host-ebda_rt=')) ?? '';
  return raw.split(';')[0];
};

export async function seedUser(
  over: Partial<{
    id: string;
    email: string;
    password: string;
    role: string;
    status: string;
    emailVerified: number;
  }> = {}
) {
  const id = over.id ?? crypto.randomUUID();
  const email = over.email ?? `u-${id.slice(0, 8)}@example.com`;
  const password = over.password ?? 'Str0ng!Passw0rd';
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified, language, created_at, updated_at)
     VALUES (?1,?2,?3,'Test','User',?4,?5,?6,'en',?7,?7)`
  )
    .bind(
      id,
      email,
      await hashPassword(password),
      over.role ?? 'store_admin',
      over.status ?? 'active',
      over.emailVerified ?? 1,
      iso()
    )
    .run();
  return { id, email, password };
}

export async function login(u: { email: string; password: string }, aud = 'store') {
  const res = await call('/login', { json: { email: u.email, password: u.password, aud } });
  const body = (await res.json()) as { data: { access_token: string; user: { id: string } } };
  return { res, body: body.data, cookie: cookieOf(res) };
}

/** The shared verifier a PRODUCT runs: ES256 only, exact iss, own aud, from a fixed JWKS document. */
export async function verifyAsProduct(token: string, audience: string) {
  const jwks = await (await call('/.well-known/jwks.json')).json();
  return jwtVerify(token, createLocalJWKSet(jwks as never), {
    algorithms: ['ES256'],
    issuer: 'https://accounts.ebda.app',
    audience,
    clockTolerance: 60,
    typ: 'at+jwt',
  });
}

/** The e-mailed code a first-factor enrolment needs (Ruling ID-15): request it the way the admin UI does, read it from the fake mailer. */
export async function emailCodeFor(u: { password: string }, bearer: string): Promise<string> {
  const r = await call('/mfa/bootstrap/code', { json: { password: u.password }, bearer });
  if (r.status !== 202) throw new Error(`bootstrap code refused: ${r.status}`);
  return fakes.mails.at(-1)!.code;
}
