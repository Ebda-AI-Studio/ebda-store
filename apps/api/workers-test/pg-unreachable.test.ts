/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS, FEATURE_KEYS_ARRAY } from '@ebda/shared';

// Ruling ROLE-GUARD-LAZY-1: with Postgres unreachable (Neon quota, 2026-10-31) the built Worker still serves
// everything D1 / a Durable Object answers. Run with EBDA_WORKERS_TEST_DB_URL pointing at a dead port.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  KV_CACHE: { put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> };
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
  it('N-18: a store is CREATED on D1 + its DO with Postgres dead, then served', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    // plans are platform data (imported in production); the subscription row's FK needs them
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      )
        .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
        .run();
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-n18',
        name: 'N18 Shop',
        slug: 'n18-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    // D1 directory row + subscription, written with no Postgres
    const row = await (
      e.PLATFORM_DB as unknown as {
        prepare(s: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } };
      }
    )
      .prepare(
        'SELECT s.storage_backend AS b, s.status AS st, sub.status AS sub FROM stores s JOIN store_subscriptions sub ON sub.store_id = s.id WHERE s.id = ?1'
      )
      .bind(id)
      .first<{ b: string; st: string; sub: string }>();
    expect(row).toEqual({ b: 'do', st: 'active', sub: 'active' });

    const headers = {
      authorization: 'Bearer workers-test-seed-token',
      'content-type': 'application/json',
    };
    // the DO is bootstrapped: the new store answers a counts probe (profile and the inactive VAT rate exist)
    const counts = await e.API.fetch(`https://api.ebda.app/api/v1/internal/store-do/${id}/counts`, {
      headers,
    });
    expect(counts.status).toBe(200);
    const body = (await counts.json()) as { data?: Record<string, number> } & Record<
      string,
      number
    >;
    const c = body.data ?? body;
    expect(c.store_profile).toBe(1);
    expect(c.tax_rates).toBe(1);

    // The storefront / auth reads are other groups' routes (N-2..N-4, N-9). What N-18 owes is that a CREATED store is served at least as
    // well as a store the platform already flagged `do`, so it is compared with the seeded spike store.
    const probeAll = async (storeId: string, slug: string) => {
      const h = { 'x-store-id': storeId };
      const get = async (u: string, init?: RequestInit) => (await e.API.fetch(u, init)).status;
      return {
        home: await get(`https://api.ebda.app/api/v1/public/stores/${slug}`),
        products: await get('https://api.ebda.app/api/v1/public/products', { headers: h }),
        pdp: await get('https://api.ebda.app/api/v1/public/products/no-such-product', {
          headers: h,
        }),
        cart: await get('https://api.ebda.app/api/v1/public/cart/items', {
          method: 'POST',
          headers: { ...h, 'content-type': 'application/json', 'x-session-id': 'sess-1' },
          body: JSON.stringify({
            productId: '33333333-3333-4333-8333-333333333333',
            quantity: 1,
          }),
        }),
      };
    };
    const mine = await probeAll(id, 'n18-shop');
    const spike = await probeAll('spike-store-1', 's');
    // A created store is never WORSE than a store the platform already flagged `do` (other groups' routes may still answer 5xx for
    // BOTH while they land; those are theirs). The PDP resolves the store from D1 with no Postgres, so it must not be a 5xx.
    for (const k of Object.keys(mine) as Array<keyof typeof mine>)
      expect(
        mine[k] >= 500 && spike[k] < 500,
        `${k}: created ${mine[k]} vs flagged ${spike[k]}`
      ).toBe(false);
    expect(mine.pdp).toBeLessThan(500);
  });

  // NEON-ZERO-1 N-12 (Rulings NZ-N12-1..3): a payment gateway callback for a Durable Object store resolves its store from the
  // D1 entity index and records/reads the inbox in D1; with Postgres dead nothing 5xx-es from a Postgres lookup.
  describe('payment webhooks for a Durable Object store', () => {
    const WH_STORE = '3c1f7a52-9d44-4e0b-8f6a-2b7d5c9e1a10';
    const hook = (txn: string) =>
      e.API.fetch('https://api.ebda.app/api/v1/webhooks/payment/paymob?hmac=deadbeef', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'TRANSACTION', obj: { id: 777, order: { id: txn } } }),
      });

    it('an unknown reference is a 503 retry (never a Postgres 500); a known one reaches the DO config read', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
        .bind(WH_STORE, 'wh', 'wh', 'owner-1', 'do')
        .run();
      const unknown = await hook('no-such-ref');
      expect(unknown.status).toBe(503);
      await e.PLATFORM_DB.prepare(
        "INSERT OR REPLACE INTO entity_index (kind, id, store_id) VALUES ('webhook', 'paymob:T-WH-1', ?1)"
      )
        .bind(WH_STORE)
        .run();
      // Resolved from the index to the DO store, whose DO holds no provider config here: the refusal is the DO-side
      // "provider not configured", i.e. the request got past the resolver and the config read WITHOUT Postgres.
      const known = await hook('T-WH-1');
      const body = (await known.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    });
  });
});

// NEON-ZERO-1 (Ruling NZ-TX-1): an authenticated admin request for a Durable Object store opens no Postgres transaction.
describe.skipIf(e.E2E_DB === '1')(
  'admin API for a Durable Object store with Postgres unreachable',
  () => {
    const STORE = '5d2c8e11-7b3a-4c6f-9a10-3e4f5a6b7c8d';
    // BLOCKED on the access marker (PR nz-access-auth): until `requireStoreAccess` reads D1, the access check itself still reads
    // Postgres (and the boot role guard 500s on the first Postgres use). Un-skip when that lands; the tenantContext half is
    // proved in tests/unit/tenant-context-do-no-pg.test.ts.
    it.skip('GET orders list answers 2xx', async () => {
      const { accessToken, authState } = await import('./helpers');
      await authState('user:tv:owner-9', [['set', 'user:tv:owner-9', '0', {}]]);
      const tok = await accessToken({ userId: 'owner-9', jti: 'j9', role: 'store_admin' });
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
        .bind(STORE, 'adm', 'adm', 'owner-9', 'do')
        .run();
      const res = await e.API.fetch(`https://api.ebda.app/api/v1/stores/${STORE}/orders?limit=5`, {
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(`${res.status} ${(await res.text()).slice(0, 200)}`).toMatch(/^2\d\d /);
    });
  }
);

// NEON-ZERO-1 N-2..N-5/N-14: the public storefront + cart for a Durable Object store with Postgres unreachable.
const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
describe.skipIf(e.E2E_DB === '1')('DO storefront + cart with Postgres unreachable', () => {
  const H = { 'x-store-id': SID, 'x-session-id': 'sess-neon-zero-1' };
  const api = (path: string, init?: RequestInit) =>
    e.API.fetch(`https://api.ebda.app/api/v1${path}`, init);
  const json = { 'content-type': 'application/json' };
  const probe: Array<[string, () => Promise<Response>]> = [
    ['store GET by slug', () => api('/public/stores/spike-shop')],
    [
      'store resolve by host',
      () => api('/public/store/resolve', { headers: { 'x-store-domain': 'spike-shop.ebda.app' } }),
    ],
    ['layout (home data)', () => api(`/public/stores/${SID}/layout`)],
    ['product list', () => api('/public/products', { headers: H })],
    ['PDP', () => api('/public/products/p', { headers: H })],
    ['category list', () => api('/public/categories', { headers: H })],
    ['search', () => api('/public/products', { headers: { ...H, 'x-search-query': 'P' } })],
    [
      'add to cart',
      () =>
        api('/public/cart/items', {
          method: 'POST',
          headers: { ...H, ...json },
          body: JSON.stringify({ productId: PID, quantity: 1 }),
        }),
    ],
    ['cart read', () => api('/public/cart', { headers: H })],
    [
      'checkout quote',
      () =>
        api('/public/orders/quote', {
          method: 'POST',
          headers: { ...H, ...json },
          body: JSON.stringify({
            paymentMethod: 'cod',
            shippingAddress: {
              firstName: 'A',
              lastName: 'B',
              address1: 'x',
              city: 'Cairo',
              state: 'Cairo',
              postalCode: '1',
              country: 'EG',
              phone: '01000000000',
            },
          }),
        }),
    ],
    // N-3: bundles (public list), the guest payment return (read of the order from the DO: an unknown order is a 404 from the
    // DO, never a Postgres 500) and the customer wishlist (the DO writer behind userContext).
    ['public bundle list', () => api(`/stores/public/${SID}/bundles`, { headers: H })],
    [
      'verify-payment (order read from the DO)',
      () =>
        api('/public/orders/33333333-3333-4333-8333-333333333333/verify-payment', {
          method: 'POST',
          headers: { ...H, ...json },
          body: '{}',
        }),
    ],
    [
      'wishlist read + add + remove (customer, DO writer)',
      async () => {
        const { accessToken, authState } = await import('./helpers');
        await authState('user:tv:cust-1', [['set', 'user:tv:cust-1', '0', {}]]);
        const tok = await accessToken({
          userId: 'cust-1',
          jti: 'jw1',
          role: 'customer',
          storeId: SID,
        });
        const h = { ...H, authorization: `Bearer ${tok}`, ...json };
        const add = await api('/wishlist', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ productId: PID }),
        });
        if (add.status >= 300) return add;
        return api('/wishlist', { headers: h });
      },
    ],
  ];
  it('seed', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(SID, 'S', 'spike-shop', 'owner-1', 'do')
      .run();
    const now = Date.now();
    const r = await api(`/internal/store-do/${SID}/seed`, {
      method: 'POST',
      headers: { authorization: 'Bearer workers-test-seed-token', ...json },
      body: JSON.stringify({
        store: { id: SID, slug: 'spike-shop', name: 'S', currency: 'EGP' },
        products: [
          {
            id: PID,
            storeId: SID,
            name: 'P',
            slug: 'p',
            price: 1000,
            inventory: 5,
            status: 'active',
            hasVariants: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    expect(r.status).toBe(200);
    // The steady state of production: the store's feature map is in the cache (5 min TTL, features:store:v3:<id>). Its COLD
    // read is the platform feature tables (N-10b), not this PR's reads, so the harness starts warm.
    const map = Object.fromEntries(FEATURE_KEYS_ARRAY.map(k => [k, k === 'bundles']));
    await e.KV_CACHE.put(`cache:features:store:v3:${SID}`, JSON.stringify(map), {
      expirationTtl: 600,
    });
  });
  // Every route answers 2xx from the DO + D1 + KV alone. The checkout quote still needs two platform reads that are not in
  // this PR: the plan entitlement (billing family, N-10a, served by D1 only after its cutover marker) and the per-store
  // `store_features` override (N-10b). `it.fails` is the tripwire: it goes red the day the quote works, so the flag is flipped.
  const blocked = new Set(['checkout quote']);
  const expect404 = new Set(['verify-payment (order read from the DO)']);
  for (const [name, call] of probe) {
    const run = async () => {
      const r = await call();
      const body = await r.text();
      if (r.status >= 300 && !blocked.has(name))
        console.log(`PROBE ${name}: ${r.status} ${body.slice(0, 300)}`);
      if (expect404.has(name)) expect(r.status).toBe(404);
      else expect(r.status).toBeLessThan(300);
    };
    if (blocked.has(name)) it.fails(`${name} (blocked on N-10a/N-10b)`, run);
    else it(name, run);
  }
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

  it('an operator suspend (setStatus) kills the refresh token at once and blocks the next login; profiles reads the DO', async () => {
    const vt = `${A}~${hex('c')}`;
    await doOp(A, 'register', {
      id: 'user-s',
      email: 'susp@exit-test.invalid',
      passwordHash: HASH,
      firstName: 'Su',
      lastName: 'Sp',
      verification: { tokenHash: await sha(vt), expiresAt: Date.now() + 3_600_000, rowId: 'v-s' },
    });
    const l = (
      await data(
        await post('/auth/login', { email: 'susp@exit-test.invalid', password: PW, storeId: A })
      )
    ).data;
    expect(l.refreshToken).toBeTruthy();
    expect(await doOp(A, 'setStatus', { userId: 'user-s', status: 'suspended' })).toMatchObject({
      ok: true,
      data: { tokenVersion: 1 },
    });
    const r = await post('/auth/refresh', { refreshToken: l.refreshToken });
    expect(r.status).toBe(401);
    const again = await post('/auth/login', {
      email: 'susp@exit-test.invalid',
      password: PW,
      storeId: A,
    });
    expect(again.status).toBe(403);
    // the directory read the merchant admin / emails / eligibility checks use: from the DO, suspended is visible
    const p = await doOp(A, 'profiles', { ids: ['user-s', 'nope'] });
    expect(p).toMatchObject({ ok: true });
    expect(JSON.stringify(p)).not.toMatch(/passwordHash|password_hash|\$2b\$/);
    expect((p as { data: Array<{ id: string; status: string }> }).data).toMatchObject([
      { id: 'user-s', status: 'suspended' },
    ]);
  });
});
