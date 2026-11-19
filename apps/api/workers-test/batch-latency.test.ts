/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * PERF-BATCH-1: the limiter checks of one request are ONE AuthState round trip per shard, and a cold store resolve reads its
 * store data in parallel. Measured on local workerd (the built Worker: D1 + StoreDO + AuthState) with a production-like 150 ms
 * per AuthState call injected (DEV_STATS-only `x-dev-authstate-delay-ms`), 30 runs per path. The latency numbers are printed
 * (BATCH_LATENCY lines); the assertions are the deterministic round-trip counts, so the test fails when the calls go
 * sequential again. Run:
 *   npm run cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/batch-latency.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      authOp(
        storeId: string,
        op: string,
        argsJson: string
      ): Promise<{ ok: true; json: string } | { ok: false; code: string }>;
    };
  };
};
const BASE = 'https://api.ebda.app/api/v1';
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.ai-usage',
  'platform_cutover.analytics',
  'platform_cutover.payments',
  'platform_cutover.ops',
  'platform_cutover.audit',
  'customer_auth_cutover.__all',
];
const EMAIL = 'batch-shopper@exit-test.invalid';
const PW = 'Passw0rd!xyz';
// bcrypt cost 4 of PW (test fixture only)
const HASH = '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm';
const RUNS = 30;
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
const DELAY = { 'x-dev-authstate-delay-ms': '150' };
/**
 * Ceilings, measured 2026-11-11 on local workerd (before -> after PERF-BATCH-1, docs/rulings/PERF-BATCH-1.md): serial waves
 * without the delay: sign-in 9 -> 7, order create 19 -> 17, cold store resolve 15 -> 11; StoreDO calls on a cold store
 * resolve 11 -> 5. Lower a ceiling whenever a change lowers the count; raising one needs a ruling.
 */
const WAVES = { signIn: 7, orderCreate: 17, resolve: 11 };
const STORE_DO_CALLS = { resolve: 5 };

let ipN = 0;
const freshIp = () => `10.93.${(ipN >> 8) & 255}.${ipN++ & 255}`;
const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  e.API.fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'cf-connecting-ip': freshIp(),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

const opsOf = (res: Response) =>
  decodeURIComponent(res.headers.get('x-dev-io-ops') ?? '')
    .split('\n')
    .filter(Boolean);
/** AuthState calls whose first op is a rate-limit hit / read (`rl:` key): the limiter round trips of one request. */
const limiterCalls = (ops: string[]) =>
  ops.filter(o => /^auth-state:@shard-\d+:apply:\[\["(?:hit|get)","rl:/.test(o));
const storeDoCalls = (ops: string[]) => ops.filter(o => o.startsWith('store-do:'));
const waves = (res: Response) =>
  Number(/io-waves;desc="(\d+)"/.exec(res.headers.get('server-timing') ?? '')?.[1] ?? 0);

type Meta = { meta: Record<string, unknown> };
type Measured = { ops: string[]; waves: number; shards: number };
/** Distinct AuthState shards among the limiter calls: one batched call per shard means calls === shards. */
const limiterShards = (ops: string[]) =>
  new Set(limiterCalls(ops).map(o => /@shard-(\d+)/.exec(o)?.[1])).size;

/**
 * RUNS timed calls with 150 ms injected per AuthState call, then ONE call without the delay to read the serial waves (the
 * injected delay runs before the tallied call starts, so under it every AuthState call counts as its own wave).
 */
async function timed(
  task: Meta,
  name: string,
  call: (headers: Record<string, string>) => Promise<Response>,
  prep: () => Promise<unknown> = async () => undefined,
  delay: Record<string, string> = DELAY
): Promise<Measured> {
  const ms: number[] = [];
  let ops: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    await prep();
    const t0 = Date.now();
    const res = await call(delay);
    const body = await res.text();
    ms.push(Date.now() - t0);
    expect(res.status, `${name}: ${body.slice(0, 300)}`).toBeLessThan(300);
    ops = opsOf(res);
  }
  await prep();
  const plain = await call({});
  expect(plain.status, `${name}: ${(await plain.text()).slice(0, 300)}`).toBeLessThan(300);
  const m: Measured = { ops, waves: waves(plain), shards: limiterShards(ops) };
  ms.sort((a, b) => a - b);
  const line =
    `BATCH_LATENCY ${name}: p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms (n=${RUNS}, ${JSON.stringify(delay)}); ` +
    `limiter calls ${limiterCalls(ops).length} on ${m.shards} shards, store-do calls ${storeDoCalls(ops).length}, ` +
    `serial waves (no delay) ${m.waves}\n  ops: ${ops.join(' | ')}`;
  task.meta.batchLatency = line;
  return m;
}

describe.skipIf(e.E2E_DB === '1')(
  'PERF-BATCH-1: batched limiter calls + parallel cold store resolve',
  () => {
    let storeId = '';
    let productId = '';
    const resolveSlugs: string[] = [];

    it('fixture: a DO store with a product and a verified shopper, plus 30 stores to resolve cold', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      for (const p of DEFAULT_PLAN_SEEDS)
        await e.PLATFORM_DB.prepare(
          'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
        )
          .bind(
            `plan-${p.code}`,
            p.code,
            p.nameEn,
            p.nameAr,
            p.featureTier,
            JSON.stringify(p.limits),
            p.priceMonthlyMinor,
            p.priceYearlyMinor
          )
          .run();
      for (const [i, k] of MARKER_KEYS.entries())
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
        )
          .bind(`batch-marker-${i}`, k)
          .run();
      const create = async (slug: string, i: number) => {
        const res = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
          method: 'POST',
          body: JSON.stringify({
            ownerId: `owner-batch-${i}`,
            name: `Batch ${i}`,
            slug,
            operator: true,
          }),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { id: string }).id;
      };
      storeId = await create('batch-shop', 0);
      for (let i = 1; i <= 2 * (RUNS + 1); i++) {
        const slug = `batch-resolve-${i}`;
        await create(slug, i);
        resolveSlugs.push(slug);
      }

      productId = crypto.randomUUID();
      const now = Date.now();
      const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: [
            {
              id: productId,
              storeId,
              name: 'Batch Product',
              slug: 'batch-product',
              price: 5000,
              inventory: 100_000,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      });
      expect(seeded.status).toBe(200);

      const sha = async (t: string) =>
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
      const vtoken = `${storeId}~${'c'.repeat(64)}`;
      const reg = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).authOp(
        storeId,
        'register',
        JSON.stringify({
          id: 'batch-user',
          email: EMAIL,
          passwordHash: HASH,
          firstName: 'Bat',
          lastName: 'Ch',
          verification: {
            tokenHash: await sha(vtoken),
            expiresAt: Date.now() + 3_600_000,
            rowId: 'v-batch',
          },
        })
      );
      expect(reg.ok, JSON.stringify(reg)).toBe(true);
      expect(
        (
          await api('/auth/verify-email', {
            method: 'POST',
            body: JSON.stringify({ token: vtoken }),
          })
        ).status
      ).toBe(200);
    }, 180_000);

    it('customer sign-in: the limiter checks are one round trip per shard', async ({ task }) => {
      let n = 0;
      const m = await timed(task as unknown as Meta, 'customer sign-in', headers =>
        api('/auth/login', {
          method: 'POST',
          headers: { ...headers, 'x-session-id': `sess-batch-login-${++n}` },
          body: JSON.stringify({ email: EMAIL, password: PW, storeId }),
        })
      );
      // rl:global + rl:auth-ip-fail + rl:auth: one batched call per shard, all in ONE wave (they were 3 serial waves)
      expect(limiterCalls(m.ops).length, m.ops.join('\n')).toBe(m.shards);
      expect(m.waves, m.ops.join('\n')).toBeLessThanOrEqual(WAVES.signIn);
    }, 120_000);

    it('guest order create (COD): the limiter checks are one round trip per shard', async ({
      task,
    }) => {
      let n = 0;
      const shopper = { 'x-store-id': storeId };
      const sess = () => `sess-batch-order-${n}`;
      const m = await timed(
        task as unknown as Meta,
        'order create (guest, cod)',
        headers =>
          api('/public/orders', {
            method: 'POST',
            headers: { ...shopper, ...headers, 'x-session-id': sess() },
            body: JSON.stringify({
              paymentMethod: 'cod',
              shippingAddress: {
                firstName: 'Batch',
                lastName: 'Order',
                address1: '1 Test St',
                city: 'Cairo',
                phone: `+2010${String(6_000_000 + n).padStart(8, '0')}`,
                country: 'EG',
              },
            }),
          }),
        async () => {
          n++;
          const add = await api('/public/cart/items', {
            method: 'POST',
            headers: { ...shopper, 'x-session-id': sess() },
            body: JSON.stringify({ productId, quantity: 1 }),
          });
          expect(add.status).toBeLessThan(300);
        }
      );
      // rl:global + the public family (+ store-miss peek) + rl:write: one call per shard, ONE wave (they were 3 serial waves)
      expect(limiterCalls(m.ops).length, m.ops.join('\n')).toBe(m.shards);
      expect(m.waves, m.ops.join('\n')).toBeLessThanOrEqual(WAVES.orderCreate);
    }, 180_000);

    it('cold store resolve: store data read in parallel', async ({ task }) => {
      let i = 0;
      const m = await timed(task as unknown as Meta, 'cold store resolve', headers =>
        api(`/public/stores/${resolveSlugs[i++]}`, { headers })
      );
      expect(limiterCalls(m.ops).length, m.ops.join('\n')).toBe(1);
      expect(storeDoCalls(m.ops).length, m.ops.join('\n')).toBeLessThanOrEqual(
        STORE_DO_CALLS.resolve
      );
      expect(m.waves, m.ops.join('\n')).toBeLessThanOrEqual(WAVES.resolve);
    }, 120_000);

    it('cold store resolve with a 40 ms StoreDO round trip too: the store reads cost one wave', async ({
      task,
    }) => {
      let i = RUNS + 1;
      const m = await timed(
        task as unknown as Meta,
        'cold store resolve (+40 ms/StoreDO call)',
        headers => api(`/public/stores/${resolveSlugs[i++]}`, { headers }),
        undefined,
        { ...DELAY, 'x-dev-storedo-delay-ms': '40' }
      );
      expect(storeDoCalls(m.ops).length, m.ops.join('\n')).toBeLessThanOrEqual(
        STORE_DO_CALLS.resolve
      );
    }, 120_000);
  }
);
