/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

// Ruling ROLE-GUARD-LAZY-1: with Postgres unreachable (Neon quota, 2026-10-31) the built Worker still serves
// everything D1 / a Durable Object answers. Run with EBDA_WORKERS_TEST_DB_URL pointing at a dead port.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      authOp(
        storeId: string,
        op: string,
        argsJson: string
      ): Promise<{ ok: true; json: string } | { ok: false; code: string; status: number }>;
    };
  };
};

describe.skipIf(e.E2E_DB === '1')('built Worker with Postgres unreachable', () => {
  it('/health is 200 with build identity (commit, deploymentId) and no Postgres', async () => {
    const res = await e.API.fetch('https://api.ebda.app/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.commit).toBe('test-sha');
    expect('deploymentId' in body).toBe(true);
  });

  it('an unknown store slug is a 404 from D1 (NEON-ZERO-1), a reserved label too, never a Postgres 500', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    const res = await e.API.fetch('https://api.ebda.app/api/v1/public/stores/no-such-store-zz9');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('STORE_NOT_FOUND');
  });

  it('a Durable Object store answers its reads (seed + counts) without Postgres', async () => {
    // The flipped state of production: the store is `do` in D1 `ebda-platform`.
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind('spike-store-1', 's', 's', 'owner-1', 'do')
      .run();
    const base = 'https://api.ebda.app/api/v1/internal/store-do/spike-store-1';
    const headers = {
      authorization: 'Bearer workers-test-seed-token',
      'content-type': 'application/json',
    };
    const now = Date.now();
    const seed = await e.API.fetch(`${base}/seed`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        store: {
          id: 'spike-store-1',
          slug: 's',
          name: 'S',
          currency: 'EGP',
          createdAt: now,
          updatedAt: now,
        },
        products: [],
      }),
    });
    expect(seed.status).toBe(200);
    const counts = await e.API.fetch(`${base}/counts`, { headers });
    expect(counts.status).toBe(200);
  });
});

// NEON-ZERO-1 N-9 (Ruling NZ-A3): storefront CUSTOMER auth for a DO store is served by its StoreDO. With Postgres dead every
// step below answers from the DO; a customer of store A is nothing on store B.
describe.skipIf(e.E2E_DB === '1')('customer auth on a StoreDO with Postgres unreachable', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const EMAIL = 'shopper@exit-test.invalid';
  const PW = 'Passw0rd!xyz';
  const PW2 = 'N3wPassw0rd!abc';
  // bcrypt cost 4 of PW (test fixture only)
  const HASH = '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm';
  const sha = async (t: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  const hex = (n: string) => n.repeat(64).slice(0, 64);
  const doOp = async (store: string, op: string, args: Record<string, unknown>) => {
    const ns = e.STORE_DO;
    const r = await ns.get(ns.idFromName(store)).authOp(store, op, JSON.stringify(args));
    return r.ok ? { ok: true as const, data: JSON.parse(r.json) } : r;
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    e.API.fetch(`https://api.ebda.app/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const data = async (r: Response) => (await r.json()) as { data?: any; error?: { code?: string } };

  const seed = async (store: string, id: string, verifyToken: string) =>
    doOp(store, 'register', {
      id,
      email: EMAIL,
      passwordHash: HASH,
      firstName: 'Sho',
      lastName: 'Pper',
      verification: {
        tokenHash: await sha(verifyToken),
        expiresAt: Date.now() + 3_600_000,
        rowId: `v-${id}`,
      },
    });

  it('register, verify, login, me, refresh, logout, reuse -> revoked family, reset, revoke-all', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const [id, slug] of [
      [A, 'cust-a'],
      [B, 'cust-b'],
    ]) {
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
        .bind(id, slug, slug, 'owner-1', 'do')
        .run();
      await e.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO system_settings (id, key, value, category, is_public) VALUES (?1, ?2, '{"on":true}', 'cutover', 0)`
      )
        .bind(`m-${id}`, `customer_auth_cutover.${id}`)
        .run();
    }

    // register through the API (hash made in the Worker, account + token created in the DO)
    const reg = await post('/auth/register', {
      email: 'new@exit-test.invalid',
      password: PW,
      name: 'New One',
      storeId: A,
    });
    expect(reg.status).toBe(200);
    expect((await data(reg)).data.emailVerificationSent).toBe(true);
    const exists = await doOp(A, 'resendVerification', {
      email: 'new@exit-test.invalid',
      tokenHash: hex('9'),
      rowId: 'r',
      expiresAt: Date.now() + 1e6,
    });
    expect(exists).toMatchObject({ ok: true, data: { kind: 'recent' } });
    // the same email on store B is a different (non-existent) account
    expect(
      await doOp(B, 'resendVerification', {
        email: 'new@exit-test.invalid',
        tokenHash: hex('9'),
        rowId: 'r',
        expiresAt: Date.now() + 1e6,
      })
    ).toMatchObject({ data: { kind: 'none' } });

    // verify (known token), login
    const vtoken = `${A}~${hex('a')}`;
    await seed(A, 'user-a', vtoken);
    expect((await post('/auth/verify-email', { token: vtoken })).status).toBe(200);
    expect((await post('/auth/verify-email', { token: vtoken })).status).toBe(400); // single use
    const bad = await post('/auth/login', { email: EMAIL, password: 'wrong-pass-1A!', storeId: A });
    expect(bad.status).toBe(401);
    const wrongStore = await post('/auth/login', { email: EMAIL, password: PW, storeId: B });
    expect(wrongStore.status).toBe(401);
    const login = await post(
      '/auth/login',
      { email: EMAIL, password: PW, storeId: A },
      { 'x-session-id': 'sess-1' }
    );
    expect(login.status).toBe(200);
    const l = (await data(login)).data;
    expect(l.user.storeId).toBe(A);
    expect(JSON.stringify(l)).not.toContain('passwordHash');

    const me = await e.API.fetch('https://api.ebda.app/api/v1/auth/me', {
      headers: { authorization: `Bearer ${l.accessToken}` },
    });
    expect(me.status).toBe(200);

    // refresh rotates; the rotated pair works
    const r1 = await post('/auth/refresh', { refreshToken: l.refreshToken });
    expect(r1.status).toBe(200);
    const t2 = (await data(r1)).data;
    expect(t2.refreshToken).not.toBe(l.refreshToken);

    // logout, then the logged-out token replayed -> reuse: the WHOLE family is revoked (t2 dies too)
    expect((await post('/auth/logout', { refreshToken: t2.refreshToken })).status).toBeLessThan(
      300
    );
    const reuse = await post('/auth/refresh', { refreshToken: t2.refreshToken });
    expect(reuse.status).toBe(401);
    expect((await data(reuse)).error?.code).toBe('TOKEN_REUSED');
    const login2 = (
      await data(await post('/auth/login', { email: EMAIL, password: PW, storeId: A }))
    ).data;
    const login3 = (
      await data(await post('/auth/login', { email: EMAIL, password: PW, storeId: A }))
    ).data;
    await post('/auth/logout', { refreshToken: login2.refreshToken });
    expect((await post('/auth/refresh', { refreshToken: login2.refreshToken })).status).toBe(401); // reuse
    expect((await post('/auth/refresh', { refreshToken: login3.refreshToken })).status).toBe(401); // family revoked

    // forgot-password is generic (200); redeem a known reset link: single use, old password dead, sessions dead
    expect((await post('/auth/forgot-password', { email: EMAIL, storeId: A })).status).toBe(200);
    const live = (await data(await post('/auth/login', { email: EMAIL, password: PW, storeId: A })))
      .data;
    const rtoken = `${A}~${hex('b')}`;
    await doOp(A, 'requestReset', {
      email: EMAIL,
      tokenHash: await sha(rtoken),
      rowId: 'rr',
      expiresAt: Date.now() + 3_600_000,
    });
    const reset = await post('/auth/reset-password', { token: rtoken, password: PW2 });
    expect(reset.status).toBe(200);
    expect(
      (await post('/auth/reset-password', { token: rtoken, password: 'Oth3rPassw0rd!zz' })).status
    ).toBe(400);
    expect((await post('/auth/login', { email: EMAIL, password: PW, storeId: A })).status).toBe(
      401
    );
    expect((await post('/auth/refresh', { refreshToken: live.refreshToken })).status).toBe(401);
    const fresh = (
      await data(
        await post(
          '/auth/login',
          { email: EMAIL, password: PW2, storeId: A },
          { 'x-session-id': 'sess-2' }
        )
      )
    ).data;
    expect(fresh.accessToken).toBeTruthy();

    // sign out everywhere is IMMEDIATE: the very next request with the old access token is 401
    const out = await post(
      '/auth/logout-all',
      {},
      {
        authorization: `Bearer ${fresh.accessToken}`,
        'x-session-id': 'sess-2',
        'x-csrf-token': fresh.csrfToken ?? '',
      }
    );
    expect(out.status).toBeLessThan(300);
    const after = await e.API.fetch('https://api.ebda.app/api/v1/auth/me', {
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    });
    expect(after.status).toBe(401);

    // a customer of A is unknown to B's DO (blocked, never tokenVersion 0)
    expect(await doOp(B, 'userState', { userId: 'user-a' })).toMatchObject({
      ok: true,
      data: null,
    });
  });
});
