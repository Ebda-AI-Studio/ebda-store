import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

// Shared setup for the ported integration tests: boots merchants on the built Worker exactly as merchant-catalogue.test.ts does
// (real ES256 identity token, the accounts stub serves the JWKS), then lets a test call any admin / public route over HTTP.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  TEST_ACCOUNTS_PRIVATE_JWK: string;
};
export const API = 'https://api.ebda.app/api/v1';
const ADMIN_ORIGIN = 'http://localhost:3001';

const b64url = (b: ArrayBuffer | string): string => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function identityToken(
  sub: string,
  email: string,
  stores: Array<{ id: string; role: string }>
) {
  const jwk = JSON.parse(e.TEST_ACCOUNTS_PRIVATE_JWK) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://accounts.ebda.app',
      aud: 'store',
      sub,
      sid: `sid-${sub}`,
      jti: crypto.randomUUID(),
      stores,
      email,
      email_verified: true,
      auth_time: now,
      iat: now,
      exp: now + 600,
    })
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

export interface Res {
  status: number;
  // pq-allow(no-any): the parsed response body is dynamic JSON that every workerd test reads by path (`.json?.data?.x`); typing it per call site is the callers' job
  json: any;
  text: string;
  headers: Headers;
}
let ipSeq = 0;
export async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Res> {
  const headers: Record<string, string> = {
    origin: ADMIN_ORIGIN,
    'cf-connecting-ip':
      init.headers?.['cf-connecting-ip'] ?? `203.0.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`,
    ...(init.headers ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await e.API.fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  // pq-allow(no-any): same dynamic response body as `Res.json` above
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON answer: kept as text
  }
  return { status: res.status, json, text, headers: res.headers };
}

let seeded = false;
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function seedPlatform(): Promise<void> {
  if (seeded) return;
  await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
  for (const [i, k] of [
    'platform_cutover.platform',
    'platform_cutover.access',
    'platform_cutover.billing',
  ].entries())
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
    )
      .bind(`fixture-marker-${i}`, k)
      .run();
  for (const p of DEFAULT_PLAN_SEEDS)
    await e.PLATFORM_DB.prepare(
      'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 49900, 499000)'
    )
      .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
      .run();
  seeded = true;
}

export interface Merchant {
  storeId: string;
  token: string;
  sub: string;
  email: string;
  slug: string;
}
let n = 0;
/** A signed-in merchant with one LIVE store (create, look, trial plan, payment methods, go-live; `live:false` stops after create, `look:false` skips the look PUT). `label` must be unique per file. */
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function bootstrapMerchant(
  label: string,
  opts: { live?: boolean; look?: boolean } = {}
): Promise<Merchant> {
  await seedPlatform();
  const i = ++n;
  const email = `${label}-merchant@exit-test.invalid`;
  const sub = `587fd55f-0000-4000-8000-${String(label.length * 1000 + i).padStart(12, '0')}`;
  const formToken = (await call('/auth/merchant/signup-token')).json?.data?.token;
  await call('/auth/merchant/signup', {
    method: 'POST',
    body: {
      email,
      password: 'Str0ng!Passw0rd-x',
      name: `${label} Merchant`,
      phone: '01012345679',
      language: 'ar',
      acceptedLegal: true,
      formToken,
    },
  });
  let token = await identityToken(sub, email, []);
  await call('/auth/session', { method: 'POST', token });
  const slug = `${label}-store`;
  const created = await call('/onboarding/store', {
    method: 'POST',
    token,
    body: { name: `${label} Store`, slug, language: 'ar' },
  });
  const storeId: string = created.json?.data?.store?.id;
  if (!storeId)
    throw new Error(`bootstrapMerchant(${label}): ${created.status} ${created.text.slice(0, 300)}`);
  token = await identityToken(sub, email, [{ id: storeId, role: 'owner' }]);
  await call('/auth/session', { method: 'POST', token });
  // `look: false` keeps the store on its onboarding defaults: the look PUT publishes page revisions (builder tests need rev 0)
  if (opts.look !== false)
    await call(`/stores/${storeId}/look`, {
      method: 'PUT',
      token,
      body: { lookId: 'qamar.atelier', design: 'reset' },
    });
  if (opts.live !== false) {
    const billing = await call(`/stores/${storeId}/billing`, { token });
    const plan = billing.json?.data?.availablePlans?.[0];
    if (plan?.code ?? plan?.planCode)
      await call(`/stores/${storeId}/billing/trial-plan`, {
        method: 'PUT',
        token,
        body: { planCode: plan.code ?? plan.planCode, interval: 'monthly' },
      });
    await call(`/onboarding/stores/${storeId}/payment-methods`, {
      method: 'PUT',
      token,
      body: { cod: true, instapay: { enabled: true, handle: 'merchant@instapay' } },
    });
    await call(`/stores/${storeId}/billing/payment-method`, {
      method: 'POST',
      token,
      body: { method: 'instapay' },
    });
    const live = await call(`/onboarding/stores/${storeId}/go-live`, { method: 'POST', token });
    if (live.status >= 400)
      throw new Error(
        `bootstrapMerchant(${label}) go-live: ${live.status} ${live.text.slice(0, 300)}`
      );
  }
  return { storeId, token, sub, email, slug };
}
