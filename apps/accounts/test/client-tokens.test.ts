/**
 * Identity contract v1.3: integrator client tokens (client_credentials). docs: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md
 * and Ebda-AI-Studio/ebda-whatsapp docs/contracts/identity-v1.3-integrator-tokens.md (r2).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeProtectedHeader } from 'jose';
import { call, fakes, login, seedUser, testEnv, verifyAsProduct } from './helpers';
import { Accounts } from '../src/index';
import { ipPrefix, pruneClientAudit, sweepDeletedStoreClients } from '../src/clients';

// the D1 survives between tests of a file: every test gets its own stores
let STORE = 'store-a';
let OTHER_STORE = 'store-b';
const WA = 'https://wa.ebda.app';
const rpc = () => new Accounts({} as never, testEnv());

beforeEach(() => {
  STORE = `store-a-${crypto.randomUUID()}`;
  OTHER_STORE = `store-b-${crypto.randomUUID()}`;
  fakes.stores = [];
  fakes.envOverride = {};
  fakes.directoryDown = false;
  fakes.deletedStores = new Set();
  fakes.suspendedStores = new Set();
});

/** An owner of STORE whose session was created with a second factor just now. */
async function owner(storeId = STORE, amr = 'pwd,otp', ageMs = 0) {
  const u = await seedUser();
  fakes.stores = [{ id: storeId, role: 'owner' }];
  const s = await login(u, 'whatsapp'); // client management needs a token issued to the integration product
  await env.DB.prepare(`UPDATE sessions SET amr = ?2, created_at = ?3 WHERE user_id = ?1`)
    .bind(u.id, amr, Date.now() - ageMs)
    .run();
  return { u, bearer: s.body.access_token };
}

const create = (bearer: string, body: Record<string, unknown> = {}, storeId = STORE) =>
  call(`/stores/${storeId}/clients`, {
    bearer,
    json: {
      name: 'ERP',
      audience: 'whatsapp',
      scopes: ['messages:send', 'contacts:read'],
      ...body,
    },
  });

async function newClient(storeId = STORE) {
  const o = await owner(storeId);
  const r = await create(o.bearer, {}, storeId);
  expect(r.status).toBe(201);
  const b = (await r.json()) as { data: { client_id: string; client_secret: string } };
  return { ...o, id: b.data.client_id, secret: b.data.client_secret };
}

const basic = (id: string, secret: string) => 'Basic ' + btoa(`${id}:${secret}`);
const token = (
  id: string,
  secret: string,
  form = 'grant_type=client_credentials&audience=whatsapp',
  headers: Record<string, string> = {}
) => call('/oauth/token', { form, headers: { authorization: basic(id, secret), ...headers } });
const ok = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('client management (owner + fresh second factor)', () => {
  it('creates a client: secret shown once, only an HMAC at rest, no-store, audited', async () => {
    const o = await owner();
    const r = await create(o.bearer);
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { data } = (await r.json()) as {
      data: { client_id: string; client_secret: string; scopes: string[]; audience: string };
    };
    expect(data.client_id).toMatch(/^cli_[A-Za-z0-9_-]{26}$/);
    expect(data.client_secret).toMatch(/^ebs_[A-Za-z0-9_-]{43}$/);
    expect(data.audience).toBe('whatsapp');
    const rows = await env.DB.prepare(`SELECT * FROM client_secrets WHERE client_id = ?1`)
      .bind(data.client_id)
      .all<{ hmac: string }>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain(data.client_secret);
    expect(rows.results[0].hmac).toMatch(/^[0-9a-f]{64}$/);
    const audit = await env.DB.prepare(
      `SELECT event, actor, store_id FROM client_audit WHERE client_id = ?1`
    )
      .bind(data.client_id)
      .all();
    expect(audit.results).toEqual([{ event: 'created', actor: o.u.id, store_id: STORE }]);
  });

  it('refuses everyone but the store owner: staff, other store, platform admin, no or stale factor, unknown scope', async () => {
    const o = await owner();
    // staff of the store
    const st = await seedUser();
    fakes.stores = [{ id: STORE, role: 'staff' }];
    const sb = (await login(st)).body.access_token;
    await env.DB.prepare(`UPDATE sessions SET amr='pwd,otp' WHERE user_id=?1`).bind(st.id).run();
    expect((await create(sb)).status).toBe(403);
    // owner of ANOTHER store
    fakes.stores = [{ id: OTHER_STORE, role: 'owner' }];
    expect((await create(o.bearer)).status).toBe(403);
    // platform admin who owns nothing here (pa is not a store role)
    const pa = await seedUser({ role: 'super_admin' });
    fakes.stores = [];
    const pb = (await login(pa)).body.access_token;
    await env.DB.prepare(`UPDATE sessions SET amr='pwd,otp' WHERE user_id=?1`).bind(pa.id).run();
    expect((await create(pb)).status).toBe(403);
    // owner, but the session has no second factor / is older than 10 minutes
    const noFactor = await owner(STORE, 'pwd');
    const r1 = await create(noFactor.bearer);
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('FACTOR_REQUIRED');
    const stale = await owner(STORE, 'pwd,otp', 11 * 60_000);
    expect((await create(stale.bearer)).status).toBe(403);
    // anonymous
    expect((await call(`/stores/${STORE}/clients`, { json: { name: 'x' } })).status).toBe(401);
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM clients WHERE store_id = ?1`)
        .bind(STORE)
        .first<{ n: number }>())!.n
    ).toBe(0);
  });

  it('validates audience and scopes: only whatsapp, only registry scopes, orders:events is refused', async () => {
    const o = await owner();
    for (const aud of ['store', 'crm', 'erp', 'platform', 'nope', 'constructor', '__proto__'])
      expect((await create(o.bearer, { audience: aud })).status).toBeGreaterThanOrEqual(400);
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM clients WHERE store_id = ?1`)
        .bind(STORE)
        .first<{ n: number }>())!.n
    ).toBe(0);
    expect((await create(o.bearer, { scopes: ['messages:send', 'admin:all'] })).status).toBe(400);
    expect((await create(o.bearer, { scopes: ['orders:events'] })).status).toBe(400);
    expect((await create(o.bearer, { scopes: [] })).status).toBe(400);
    expect((await create(o.bearer, { name: '' })).status).toBe(400);
  });

  it('lists a store clients with usage and no secret material, and only to the owner', async () => {
    const c = await newClient();
    await token(c.id, c.secret);
    const r = await call(`/stores/${STORE}/clients`, { bearer: c.bearer });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(c.secret);
    expect(text).not.toMatch(/hmac/i);
    const { data } = JSON.parse(text) as {
      data: Array<{ client_id: string; last_used_at: number | null; secrets: unknown[] }>;
    };
    expect(data).toHaveLength(1);
    expect(data[0].client_id).toBe(c.id);
    expect(data[0].last_used_at).toBeGreaterThan(0);
    expect(data[0].secrets).toHaveLength(1);
    fakes.stores = [{ id: STORE, role: 'staff' }];
    expect((await call(`/stores/${STORE}/clients`, { bearer: c.bearer })).status).toBe(403);
  });

  it('cannot touch another store client (rotate, revoke)', async () => {
    const a = await newClient(STORE);
    const b = await owner(OTHER_STORE);
    expect(
      (await call(`/stores/${OTHER_STORE}/clients/${a.id}/rotate`, { bearer: b.bearer, json: {} }))
        .status
    ).toBe(404);
    expect(
      (await call(`/stores/${OTHER_STORE}/clients/${a.id}`, { method: 'DELETE', bearer: b.bearer }))
        .status
    ).toBe(404);
    expect((await token(a.id, a.secret)).status).toBe(200);
  });

  it('a client access token can never manage clients', async () => {
    const c = await newClient();
    const t = ((await ok(await token(c.id, c.secret))) as { access_token: string }).access_token;
    fakes.stores = [{ id: STORE, role: 'owner' }];
    expect((await call(`/stores/${STORE}/clients`, { bearer: t })).status).toBe(401);
    expect((await create(t)).status).toBe(401);
  });
});

describe('POST /oauth/token', () => {
  it('issues a 10-minute at+jwt with the v1.3 claims and no refresh token', async () => {
    const c = await newClient();
    const r = await token(c.id, c.secret);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'messages:send contacts:read',
    });
    expect(body).not.toHaveProperty('refresh_token');
    const t = body.access_token as string;
    expect(decodeProtectedHeader(t)).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
    const { payload } = await verifyAsProduct(t, 'whatsapp');
    expect(payload).toMatchObject({
      iss: 'https://accounts.ebda.app',
      aud: 'whatsapp',
      sub: c.id,
      sid: c.id,
      client: true,
      scope: 'messages:send contacts:read',
      stores: [{ id: STORE, role: 'integration' }],
    });
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(payload.nbf).toBe(payload.iat);
    expect(typeof payload.jti).toBe('string');
    for (const k of ['pa', 'auth_time', 'email', 'email_verified'])
      expect(payload).not.toHaveProperty(k);
    // audited with the jti, slot and scope, no secret
    const a = await env.DB.prepare(
      `SELECT jti, secret_slot, scope, ip_prefix FROM client_audit WHERE event='issued' AND client_id=?1`
    )
      .bind(c.id)
      .first<{ jti: string; secret_slot: number; scope: string; ip_prefix: string }>();
    expect(a).toMatchObject({
      jti: payload.jti,
      secret_slot: 1,
      scope: 'messages:send contacts:read',
    });
  });

  it('a client token is not valid for the store audience and is revoked-aware via isRevoked(cli_)', async () => {
    const c = await newClient();
    const t = ((await ok(await token(c.id, c.secret))) as { access_token: string }).access_token;
    await expect(verifyAsProduct(t, 'store')).rejects.toThrow();
    expect(await rpc().isRevoked(c.id)).toBe(false);
    expect(await rpc().isRevoked('cli_doesnotexist000000000000')).toBe(true);
  });

  it('narrows to a requested subset and refuses a scope the client does not hold', async () => {
    const c = await newClient();
    const r = await token(
      c.id,
      c.secret,
      'grant_type=client_credentials&audience=whatsapp&scope=contacts%3Aread'
    );
    expect(((await r.json()) as { scope: string }).scope).toBe('contacts:read');
    const bad = await token(
      c.id,
      c.secret,
      'grant_type=client_credentials&audience=whatsapp&scope=contacts%3Awrite'
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_scope');
  });

  it('audience: omitted = the client own; a different one is unauthorized_client; aud=store is never issued', async () => {
    const c = await newClient();
    expect((await token(c.id, c.secret, 'grant_type=client_credentials')).status).toBe(200);
    for (const aud of ['store', 'crm']) {
      const r = await token(c.id, c.secret, `grant_type=client_credentials&audience=${aud}`);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('unauthorized_client');
    }
  });

  it('refuses a request carrying an Origin header (even an allow-listed one), a body secret, and other grants', async () => {
    const c = await newClient();
    for (const origin of [WA, 'https://evil.example'])
      expect((await token(c.id, c.secret, undefined, { origin })).status).toBeGreaterThanOrEqual(
        400
      );
    const viaOrigin = await token(c.id, c.secret, undefined, { origin: WA });
    expect(viaOrigin.headers.get('access-control-allow-origin')).toBeNull();
    const body = await call('/oauth/token', {
      form: `grant_type=client_credentials&audience=whatsapp&client_id=${c.id}&client_secret=${c.secret}`,
    });
    expect(body.status).toBe(400);
    expect(((await body.json()) as { error: string }).error).toBe('invalid_request');
    const g = await token(c.id, c.secret, 'grant_type=password&audience=whatsapp');
    expect(((await g.json()) as { error: string }).error).toBe('unsupported_grant_type');
    const pre = await call('/oauth/token', { method: 'OPTIONS', headers: { origin: WA } });
    expect(pre.headers.get('access-control-allow-methods') ?? '').not.toMatch(/POST/);
  });

  it('answers ONE uniform 401 for unknown id, wrong secret, revoked client and malformed credentials', async () => {
    const c = await newClient();
    const revoked = await newClient();
    expect(
      (
        await call(`/stores/${STORE}/clients/${revoked.id}`, {
          method: 'DELETE',
          bearer: revoked.bearer,
        })
      ).status
    ).toBe(200);
    const cases = [
      token('cli_unknown0000000000000000aa', c.secret),
      token(c.id, 'ebs_wrong'),
      token(revoked.id, revoked.secret),
      call('/oauth/token', {
        form: 'grant_type=client_credentials',
        headers: { authorization: 'Basic !!!' },
      }),
      call('/oauth/token', { form: 'grant_type=client_credentials' }),
    ];
    const seen = new Set<string>();
    for (const p of cases) {
      const r = await p;
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Basic/);
      seen.add(await r.text());
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain('invalid_client');
  });

  it('runs a (dummy) secret comparison for an unknown id, like a known one', async () => {
    const c = await newClient();
    const before = await env.DB.prepare(
      `SELECT count(*) AS n FROM client_audit WHERE event='auth_failed'`
    ).first<{ n: number }>();
    expect((await token('cli_unknown0000000000000000aa', 'ebs_x')).status).toBe(401);
    expect((await token(c.id, 'ebs_x')).status).toBe(401);
    const after = await env.DB.prepare(
      `SELECT count(*) AS n FROM client_audit WHERE event='auth_failed'`
    ).first<{ n: number }>();
    // only a KNOWN client gets a failed-auth row (unknown ids cannot grow the table)
    expect(after!.n - before!.n).toBe(1);
  });

  it('fails loud (503) when the pepper is missing, for management and for tokens', async () => {
    const o = await owner();
    fakes.envOverride = { CLIENT_SECRET_PEPPER: '' };
    expect((await create(o.bearer)).status).toBe(503);
    expect((await token('cli_x', 'ebs_y')).status).toBe(503);
    fakes.envOverride = { CLIENT_SECRET_PEPPER: 'AAAA' }; // too short to be a key
    expect((await token('cli_x', 'ebs_y')).status).toBe(503);
  });
});

describe('rate limits', () => {
  it('the 61st token in an hour is 429 with Retry-After', async () => {
    const c = await newClient();
    const ip = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < 60; i++) {
      const r = await token(c.id, c.secret, undefined, ip);
      expect(r.status).toBe(200);
    }
    const r = await token(c.id, c.secret, undefined, ip);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await r.json()) as { error: string }).error).toBe('slow_down');
  });

  it('wrong secrets from one IP are throttled there but never lock the real client elsewhere', async () => {
    const c = await newClient();
    const bad = { 'cf-connecting-ip': '198.51.100.9' };
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await token(c.id, 'ebs_guess' + i, undefined, bad)).status;
    expect(last).toBe(429);
    // the attacker IP is blocked even with the right secret, a different IP is not
    expect((await token(c.id, c.secret, undefined, bad)).status).toBe(429);
    expect(
      (await token(c.id, c.secret, undefined, { 'cf-connecting-ip': '192.0.2.44' })).status
    ).toBe(200);
  });
});

describe('rotation (24 h overlap) and revocation', () => {
  it('rotates: both secrets work, the old one stops at its expiry, issued tokens survive, slot is audited', async () => {
    const c = await newClient();
    const before = ((await ok(await token(c.id, c.secret))) as { access_token: string })
      .access_token;
    const r = await call(`/stores/${STORE}/clients/${c.id}/rotate`, { bearer: c.bearer, json: {} });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const fresh = ((await r.json()) as { data: { client_secret: string } }).data.client_secret;
    expect(fresh).toMatch(/^ebs_/);
    expect(fresh).not.toBe(c.secret);
    expect((await token(c.id, c.secret)).status).toBe(200);
    expect((await token(c.id, fresh)).status).toBe(200);
    const exp = await env.DB.prepare(
      `SELECT expires_at FROM client_secrets WHERE client_id=?1 AND slot=1`
    )
      .bind(c.id)
      .first<{ expires_at: number }>();
    expect(exp!.expires_at - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(exp!.expires_at - Date.now()).toBeLessThan(24.1 * 3600_000);
    const slots = await env.DB.prepare(
      `SELECT secret_slot FROM client_audit WHERE event='issued' AND client_id=?1 ORDER BY id`
    )
      .bind(c.id)
      .all<{ secret_slot: number }>();
    expect(slots.results.map(x => x.secret_slot)).toEqual([1, 1, 2]);
    // overlap in progress: a second rotate is refused
    const again = await call(`/stores/${STORE}/clients/${c.id}/rotate`, {
      bearer: c.bearer,
      json: {},
    });
    expect(again.status).toBe(409);
    // the old secret expires
    await env.DB.prepare(`UPDATE client_secrets SET expires_at = ?2 WHERE client_id=?1 AND slot=1`)
      .bind(c.id, Date.now() - 1000)
      .run();
    expect((await token(c.id, c.secret)).status).toBe(401);
    expect((await token(c.id, fresh)).status).toBe(200);
    // tokens minted before the rotation are not revoked by it
    expect(await rpc().isRevoked(c.id)).toBe(false);
    void before;
    // and a new rotation is possible again
    expect(
      (await call(`/stores/${STORE}/clients/${c.id}/rotate`, { bearer: c.bearer, json: {} })).status
    ).toBe(200);
  });

  it('overlapHours 0 revokes the old secret at once; more than 7 days is refused', async () => {
    const c = await newClient();
    expect(
      (
        await call(`/stores/${STORE}/clients/${c.id}/rotate`, {
          bearer: c.bearer,
          json: { overlapHours: 169 },
        })
      ).status
    ).toBe(400);
    const r = await call(`/stores/${STORE}/clients/${c.id}/rotate`, {
      bearer: c.bearer,
      json: { overlapHours: 0 },
    });
    const fresh = ((await r.json()) as { data: { client_secret: string } }).data.client_secret;
    expect((await token(c.id, c.secret)).status).toBe(401);
    expect((await token(c.id, fresh)).status).toBe(200);
  });

  it('rotate and revoke need a fresh second factor', async () => {
    const c = await newClient();
    await env.DB.prepare(`UPDATE sessions SET amr='pwd' WHERE user_id=?1`).bind(c.u.id).run();
    expect(
      (await call(`/stores/${STORE}/clients/${c.id}/rotate`, { bearer: c.bearer, json: {} })).status
    ).toBe(403);
    expect(
      (await call(`/stores/${STORE}/clients/${c.id}`, { method: 'DELETE', bearer: c.bearer }))
        .status
    ).toBe(403);
    expect((await token(c.id, c.secret)).status).toBe(200);
  });

  it('revoke: no new tokens, isRevoked true at once, audited', async () => {
    const c = await newClient();
    const t = ((await ok(await token(c.id, c.secret))) as { access_token: string }).access_token;
    expect(t).toBeTruthy();
    expect(
      (await call(`/stores/${STORE}/clients/${c.id}`, { method: 'DELETE', bearer: c.bearer }))
        .status
    ).toBe(200);
    expect(await rpc().isRevoked(c.id)).toBe(true);
    expect((await token(c.id, c.secret)).status).toBe(401);
    const ev = await env.DB.prepare(
      `SELECT event FROM client_audit WHERE client_id=?1 AND event='revoked'`
    )
      .bind(c.id)
      .all();
    expect(ev.results).toHaveLength(1);
  });
});

describe('store deletion and retention', () => {
  it('deleteStoreClients removes clients, secrets and every audit row; other stores are untouched', async () => {
    const a = await newClient(STORE);
    const b = await newClient(OTHER_STORE);
    await token(a.id, a.secret);
    const res = await rpc().deleteStoreClients(STORE);
    expect(res).toEqual({ clients: 1 });
    for (const t of ['clients', 'client_secrets', 'client_audit']) {
      const col = t === 'client_secrets' ? 'client_id' : t === 'clients' ? 'id' : 'client_id';
      const n = await env.DB.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?1`)
        .bind(a.id)
        .first<{ n: number }>();
      expect(n!.n).toBe(0);
    }
    expect(await rpc().isRevoked(a.id)).toBe(true);
    expect((await token(a.id, a.secret)).status).toBe(401);
    expect((await token(b.id, b.secret)).status).toBe(200);
    expect(await rpc().deleteStoreClients(STORE)).toEqual({ clients: 0 });
    await expect(rpc().deleteStoreClients('')).rejects.toThrow();
  });

  it('the hourly prune drops issued and failed-auth rows older than 90 days and keeps lifecycle rows', async () => {
    const c = await newClient();
    await token(c.id, c.secret);
    const old = Date.now() - 91 * 86_400_000;
    await env.DB.prepare(
      `INSERT INTO client_audit (client_id, store_id, event, at) VALUES (?1,?2,'issued',?3),(?1,?2,'revoked',?3),(?1,?2,'auth_failed',?3)`
    )
      .bind(c.id, STORE, old)
      .run();
    const removed = await pruneClientAudit(env.DB);
    expect(removed).toBe(2); // the old issued row and the old auth_failed row
    const left = await env.DB.prepare(
      `SELECT event FROM client_audit WHERE client_id=?1 ORDER BY id`
    )
      .bind(c.id)
      .all<{ event: string }>();
    expect(left.results.map(x => x.event)).toEqual(['created', 'issued', 'revoked']);
  });
});

describe('management is bound to the integration product (audience)', () => {
  const tokenFor = async (aud: string, storeId = STORE) => {
    const u = await seedUser();
    fakes.stores = [{ id: storeId, role: 'owner' }];
    const s = await login(u, aud);
    await env.DB.prepare(`UPDATE sessions SET amr = 'pwd,otp' WHERE user_id = ?1`).bind(u.id).run();
    return s.body.access_token;
  };

  it('a store, crm or erp token cannot create, rotate or list whatsapp clients; a whatsapp token can', async () => {
    const c = await newClient();
    for (const aud of ['store', 'crm', 'erp']) {
      const t = await tokenFor(aud);
      const r = await create(t);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        'AUDIENCE_MISMATCH'
      );
      expect(
        (await call(`/stores/${STORE}/clients/${c.id}/rotate`, { bearer: t, json: {} })).status
      ).toBe(403);
      expect((await call(`/stores/${STORE}/clients`, { bearer: t })).status).toBe(403);
    }
    expect((await call(`/stores/${STORE}/clients`, { bearer: c.bearer })).status).toBe(200);
    expect((await token(c.id, c.secret)).status).toBe(200);
  });

  it('any audience of the owner may REVOKE (it only reduces access), still with a fresh second factor', async () => {
    const c = await newClient();
    const t = await tokenFor('store');
    expect(
      (await call(`/stores/${STORE}/clients/${c.id}`, { method: 'DELETE', bearer: t })).status
    ).toBe(200);
    expect((await token(c.id, c.secret)).status).toBe(401);
  });

  it('a browser Origin must belong to the token product, and only the integration origin gets CORS on these routes', async () => {
    const c = await newClient();
    const bad = await call(`/stores/${STORE}/clients`, {
      bearer: c.bearer,
      headers: { origin: 'https://store.ebda.app' },
    });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await call(`/stores/${STORE}/clients`, {
      bearer: c.bearer,
      headers: { origin: WA },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(WA);
    const pre = (origin: string) =>
      call(`/stores/${STORE}/clients/cli_x`, { method: 'OPTIONS', headers: { origin } });
    expect((await pre('https://store.ebda.app')).status).toBe(403);
    expect((await pre(WA)).status).toBe(204);
  });
});

describe('a deleted store ends its clients at once', () => {
  it('token issue is refused (401) and isRevoked is true the moment the directory says the store is gone', async () => {
    const c = await newClient();
    const t = ((await ok(await token(c.id, c.secret))) as { access_token: string }).access_token;
    expect(t).toBeTruthy();
    expect(await rpc().isRevoked(c.id)).toBe(false);
    fakes.deletedStores.add(STORE);
    expect((await token(c.id, c.secret)).status).toBe(401);
    expect(await rpc().isRevoked(c.id)).toBe(true);
  });

  it('a directory outage fails CLOSED: 503 at issue, and isRevoked throws instead of answering "not revoked"', async () => {
    const c = await newClient();
    fakes.directoryDown = true;
    expect((await token(c.id, c.secret)).status).toBe(503);
    await expect(rpc().isRevoked(c.id)).rejects.toThrow();
  });

  it('the hourly sweep removes clients of deleted stores, keeps live ones, and retries what the directory could not answer', async () => {
    const gone = await newClient(STORE);
    const live = await newClient(OTHER_STORE);
    const dir = new Set<string>([STORE]);
    let down = true;
    const exists = async (id: string) => {
      if (down) throw new Error('down');
      return !dir.has(id);
    };
    expect(await sweepDeletedStoreClients(env.DB, exists)).toBe(0); // directory down: nothing removed
    expect((await token(live.id, live.secret)).status).toBe(200);
    down = false;
    fakes.deletedStores.add(STORE);
    expect(await sweepDeletedStoreClients(env.DB, exists)).toBeGreaterThanOrEqual(1);
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM clients WHERE id IN (?1, ?2)`)
      .bind(gone.id, live.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect((await token(live.id, live.secret)).status).toBe(200);
  });
});

describe('hardening', () => {
  it('failed authentication leaves at most one trail row per client per minute', async () => {
    const c = await newClient();
    for (let i = 0; i < 6; i++)
      await token(c.id, 'ebs_wrong' + i, undefined, { 'cf-connecting-ip': `198.51.100.${i}` });
    const n = await env.DB.prepare(
      `SELECT count(*) AS n FROM client_audit WHERE client_id = ?1 AND event = 'auth_failed'`
    )
      .bind(c.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('IPv4-mapped IPv6 addresses count as the IPv4 address they carry', () => {
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
  });

  it('ipPrefix is a /24 and a real /64 even for compressed IPv6', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipPrefix('2001:db8::1')).toBe(ipPrefix('2001:db8::2'));
    expect(ipPrefix('unknown')).toBe('unknown');
  });
});

describe('suspended stores and sweep paging', () => {
  it('a suspended store stops its integrations at once (issue refused, isRevoked true) but its clients are KEPT', async () => {
    const c = await newClient();
    expect((await token(c.id, c.secret)).status).toBe(200);
    fakes.suspendedStores.add(STORE);
    expect((await token(c.id, c.secret)).status).toBe(401);
    expect(await rpc().isRevoked(c.id)).toBe(true);
    // the sweep only removes DELETED stores: suspension is reversible
    const removed = await sweepDeletedStoreClients(
      env.DB,
      async id => !fakes.deletedStores.has(id)
    );
    expect(removed).toBe(0);
    fakes.suspendedStores.delete(STORE);
    expect((await token(c.id, c.secret)).status).toBe(200);
    expect(await rpc().isRevoked(c.id)).toBe(false);
  });

  it('the sweep pages through every store with a cursor and wraps around', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await newClient(`sweep-${crypto.randomUUID()}`)).id);
    }
    await env.DB.prepare(`DELETE FROM sweep_state`).run();
    const all = (
      await env.DB.prepare(`SELECT DISTINCT store_id FROM clients`).all<{ store_id: string }>()
    ).results.map(r => r.store_id);
    const dead = new Set(all.filter(s => s.startsWith('sweep-')));
    let total = 0;
    // page size 1: it takes as many runs as there are stores to see the last one
    for (let i = 0; i < all.length + 1; i++)
      total += await sweepDeletedStoreClients(env.DB, async id => !dead.has(id), 1);
    expect(total).toBe(3);
    const left = await env.DB.prepare(`SELECT count(*) AS n FROM clients WHERE id IN (?1,?2,?3)`)
      .bind(...ids)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
