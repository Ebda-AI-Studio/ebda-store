import { env } from 'cloudflare:test';
import { createApp } from '../src/app';
import { hashPassword } from '../src/password';
import { iso } from '../src/util';
import { createLocalJWKSet, jwtVerify } from 'jose';

const app = createApp();

export interface Fakes {
  stores: Array<{ id: string; role: 'owner' | 'staff' }>;
  mails: Array<{ to: string; kind: string; code: string }>;
  directoryDown: boolean;
}
export const fakes: Fakes = { stores: [], mails: [], directoryDown: false };

export const testEnv = (): Cloudflare.Env =>
  ({
    ...env,
    ISSUER: 'https://accounts.ebda.app',
    PRODUCTS: 'store,whatsapp,crm,erp',
    PASSKEY_ORIGINS: 'https://store.ebda.app,https://orders.ebda.app',
    STORE_DIRECTORY: {
      storesForUser: async () => {
        if (fakes.directoryDown) throw new Error('down');
        return fakes.stores;
      },
    },
    MAILER: {
      sendCode: async (m: { to: string; kind: string; code: string }) => {
        fakes.mails.push({ to: m.to, kind: m.kind, code: m.code });
      },
    },
  }) as unknown as Cloudflare.Env;

const BASE = 'https://accounts.ebda.app';

export async function call(
  path: string,
  init: RequestInit & {
    cookie?: string;
    bearer?: string;
    json?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'cf-connecting-ip': '203.0.113.7',
    ...(init.headers ?? {}),
  };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const req = new Request(BASE + path, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return app.fetch(req, testEnv(), {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);
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
