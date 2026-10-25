// Live end-to-end check of the identity service against PRODUCTION, using a throwaway merchant that this script creates and
// removes (identity D1 only: pre-launch, no real users touched, Postgres is never written to directly).
//
//   CLOUDFLARE_ACCOUNT_ID=... node scripts/live-check.mjs [--keep]
//
// Covers: JWKS + openid-configuration, password login, access-token claims (ES256, aud, iss, stores), the Store's
// POST /auth/session cookie exchange and an authenticated API call, SSO (a second audience from the same cookie), logout and
// that the old access token is refused by the Store on the next request, wrong-password/lockout shape, CORS/CSRF refusals.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';

const ACCOUNTS = process.env.ACCOUNTS_URL || 'https://accounts.ebda.app';
const API = process.env.API_URL || 'https://api.ebda.app';
const ORIGIN = 'https://store.ebda.app';
const keep = process.argv.includes('--keep');
const id = crypto.randomUUID();
const email = `identity-live-${randomBytes(4).toString('hex')}@example.com`;
const password = `Lv!${randomBytes(9).toString('base64url')}9a`;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const d1 = sql => {
  const r = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'ebda-identity', '--remote', '--json', '--command', sql],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`d1 failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
};
const now = new Date().toISOString();
const hash = await bcrypt.hash(password, 12);
d1(
  `INSERT INTO users (id,email,password_hash,first_name,last_name,role,status,email_verified,language,created_at,updated_at) VALUES ('${id}','${email}','${hash}','Live','Check','store_admin','active',1,'en','${now}','${now}')`
);

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');

try {
  const jwks = await (await fetch(`${ACCOUNTS}/.well-known/jwks.json`)).json();
  check(
    'jwks publishes public ES256 keys only',
    jwks.keys?.length >= 1 && jwks.keys.every(k => !k.d && k.alg === 'ES256' && k.kid)
  );
  const oc = await (await fetch(`${ACCOUNTS}/.well-known/openid-configuration`)).json();
  check(
    'openid-configuration issuer + jwks_uri',
    oc.issuer === ACCOUNTS && oc.jwks_uri === `${ACCOUNTS}/.well-known/jwks.json`
  );

  const bad = await post(`${ACCOUNTS}/login`, { email, password: 'wrong-password-1' });
  check('wrong password is a plain 401', bad.status === 401);

  const login = await post(`${ACCOUNTS}/login`, { email, password, aud: 'store' });
  const body = await login.json();
  check('login 200', login.status === 200, `status=${login.status}`);
  const setCookie = login.headers.getSetCookie?.().find(c => c.startsWith('__Host-ebda_rt=')) ?? '';
  check(
    'refresh cookie is host-only, Secure, HttpOnly, SameSite=Lax',
    /; Secure/.test(setCookie) &&
      /; HttpOnly/.test(setCookie) &&
      /SameSite=Lax/.test(setCookie) &&
      !/Domain=/i.test(setCookie)
  );
  const token = body.data?.access_token;
  const hdr = decodeProtectedHeader(token);
  check(
    'token header ES256 / at+jwt / kid',
    hdr.alg === 'ES256' && hdr.typ === 'at+jwt' && !!hdr.kid
  );
  const { payload } = await jwtVerify(
    token,
    createRemoteJWKSet(new URL(`${ACCOUNTS}/.well-known/jwks.json`)),
    { issuer: ACCOUNTS, audience: 'store', algorithms: ['ES256'] }
  );
  check(
    'token verifies against the published JWKS; claims',
    payload.sub === id && Array.isArray(payload.stores) && payload.exp - payload.iat === 900,
    `stores=${JSON.stringify(payload.stores)}`
  );

  // The shape every product's verifier relies on (contract v1.2): asserted from the REAL token; the token itself is never logged.
  const nowS = Math.floor(Date.now() / 1000);
  const isUuid = v =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  check(
    'claims: iss / aud / sub',
    payload.iss === ACCOUNTS && payload.aud === 'store' && payload.sub === id
  );
  check(
    'claims: iat = nbf, exp = iat + 900, not expired, iat not in the future (60 s skew)',
    payload.nbf === payload.iat &&
      payload.exp - payload.iat === 900 &&
      payload.exp > nowS &&
      payload.iat <= nowS + 60
  );
  check('claims: sid and jti are uuids', isUuid(payload.sid) && isUuid(payload.jti));
  check(
    'claims: stores[] entries are { id: uuid, role: owner|staff }',
    Array.isArray(payload.stores) &&
      payload.stores.every(
        s =>
          isUuid(s.id) &&
          ['owner', 'staff'].includes(s.role) &&
          Object.keys(s).sort().join() === 'id,role'
      )
  );
  check(
    'claims: auth_time present, email_verified boolean, no platform role for a merchant',
    typeof payload.auth_time === 'number' &&
      typeof payload.email_verified === 'boolean' &&
      payload.pa === undefined
  );

  // Store: exchange for the API cookie, then an authenticated call
  const sess = await fetch(`${API}/api/v1/auth/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
  });
  const sessBody = await sess.json();
  check(
    'Store POST /auth/session 200 and sets the API cookie',
    sess.status === 200 && /^token=/.test(cookieOf(sess)),
    `status=${sess.status} ${sess.status !== 200 ? JSON.stringify(sessBody).slice(0, 200) : ''}`
  );
  const me = await fetch(`${API}/api/v1/auth/me`, {
    headers: { cookie: cookieOf(sess), origin: ORIGIN },
  });
  const meBody = await me.json();
  check(
    'Store /auth/me with that cookie returns the merchant',
    me.status === 200 && meBody.data?.user?.id === id,
    `status=${me.status}`
  );
  const bearerMe = await fetch(`${API}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
  });
  check('Store accepts the ES256 bearer directly', bearerMe.status === 200);

  // SSO: a second product audience from the SAME cookie
  const rt = login.headers
    .getSetCookie()
    .find(c => c.startsWith('__Host-ebda_rt='))
    .split(';')[0];
  const wa = await fetch(`${ACCOUNTS}/token?aud=whatsapp`, {
    headers: { cookie: rt, origin: 'https://wa.ebda.app' },
  });
  const waTok = (await wa.json()).data?.access_token;
  check('SSO: the same cookie mints an aud=whatsapp token', wa.status === 200 && !!waTok);
  const waVerify = await jwtVerify(
    waTok,
    createRemoteJWKSet(new URL(`${ACCOUNTS}/.well-known/jwks.json`)),
    { issuer: ACCOUNTS, audience: 'whatsapp', algorithms: ['ES256'] }
  ).then(
    () => true,
    () => false
  );
  check('...and it verifies only for its own audience', waVerify);
  const waAtStore = await fetch(`${API}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${waTok}`, origin: ORIGIN },
  });
  check(
    'the Store REFUSES the whatsapp-audience token',
    waAtStore.status === 401,
    `status=${waAtStore.status}`
  );

  // CSRF / CORS
  const cross = await fetch(`${ACCOUNTS}/token?aud=store`, {
    headers: { cookie: rt, origin: 'https://evil.example' },
  });
  check('a hostile Origin is refused', cross.status === 403);
  const form = await fetch(`${ACCOUNTS}/login`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  check('a non-JSON login post is refused (415)', form.status === 415);

  // logout everywhere
  const out = await fetch(`${ACCOUNTS}/logout`, {
    method: 'POST',
    headers: { cookie: rt, origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    'logout 200 and clears the cookie',
    out.status === 200 && /Max-Age=0/.test(out.headers.getSetCookie().join(';'))
  );
  const after = await fetch(`${API}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
  });
  check(
    'the still-unexpired access token is refused by the Store on the NEXT request',
    after.status === 401,
    `status=${after.status}`
  );
  const afterCookie = await fetch(`${API}/api/v1/auth/me`, {
    headers: { cookie: cookieOf(sess), origin: ORIGIN },
  });
  check(
    '...and so is the Store cookie that carried it',
    afterCookie.status === 401,
    `status=${afterCookie.status}`
  );
  const refreshAfter = await fetch(`${ACCOUNTS}/token?aud=store`, {
    headers: { cookie: rt, origin: ORIGIN },
  });
  check('the identity refresh cookie is dead too', refreshAfter.status === 401);
  const waAfter = await fetch(`${ACCOUNTS}/token?aud=whatsapp`, {
    headers: { cookie: rt, origin: 'https://wa.ebda.app' },
  });
  check('...for every product (SSO logout)', waAfter.status === 401);
} finally {
  if (!keep) d1(`DELETE FROM users WHERE id = '${id}'`);
  console.log(keep ? `kept test identity ${email}` : 'test identity removed from D1');
}
console.log(failures ? `FAILED: ${failures}` : 'ALL PASS');
process.exit(failures ? 1 : 0);
