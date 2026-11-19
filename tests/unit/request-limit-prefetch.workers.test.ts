/**
 * PERF-BATCH-1: the limiter checks of one request go to AuthState as ONE batched call per shard, all started before the first
 * answers (counted round trips: fails when they go sequential again); each limiter still trips at its own limit with its own
 * 429 body; a batched call that times out applies the strictest fail class among its members (Ruling API-HANG-2); every
 * express-rate-limit limiter in the API router either carries a plan or is a named user-keyed exception.
 * Runs the real limiters (security.ts) through express on Node with `isWorkers` forced on and an in-process AuthState.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthStateStore, type Op } from '@api/cf/auth-state-core';
import { createSqlite } from '../helpers/sqlite-sql';

vi.mock('@api/lib/runtime', () => ({ isWorkers: true }));

const { clearCfBindings, setCfBindings } = await import('@api/cf/bindings');
const { shardOf, AUTH_STATE_TIMEOUT_MS, AuthStateTimeoutError } =
  await import('@api/cf/auth-state-client');
const { CfRateLimitStore, FAIL_CLOSED_HITS, prefetchHits, runWithPrefetchedHits } =
  await import('@api/cf/rate-limit-store');
const security = await import('@api/middleware/security');
const { prefetchRequestLimits, raiseHeldBodyError } =
  await import('@api/middleware/request-limit-prefetch');
const { allLimiterHandles, limitPlanOf } = await import('@api/middleware/limit-plan');

/** In-process AuthState: one sqlite-backed store per shard; counts calls and how many were in flight at once. */
class FakeAuthState {
  readonly stores = new Map<string, AuthStateStore>();
  calls: Array<{ shard: string; ops: Op[] }> = [];
  inFlight = 0;
  maxInFlight = 0;
  stuck = new Set<string>();
  idFromName(name: string) {
    return name;
  }
  get(id: unknown) {
    const name = String(id);
    if (!this.stores.has(name)) this.stores.set(name, new AuthStateStore(createSqlite()));
    const store = this.stores.get(name)!;
    return {
      apply: async (ops: Op[]) => {
        this.calls.push({ shard: name, ops });
        if (this.stuck.has(name)) return new Promise<never>(() => undefined);
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        await new Promise(r => setTimeout(r, 5)); // a round trip: concurrent calls overlap, chained ones do not
        this.inFlight--;
        return ops.map(op => store.run(op, Date.now()));
      },
    } as never;
  }
  /** Rate-limit round trips (the first op is a hit / read of an `rl:` key). */
  limiterCalls() {
    return this.calls.filter(c => String(c.ops[0]?.[1] ?? '').startsWith('rl:'));
  }
  reset() {
    this.calls = [];
    this.maxInFlight = 0;
  }
}

let as: FakeAuthState;
beforeEach(() => {
  as = new FakeAuthState();
  setCfBindings({ AUTH_STATE: as } as never);
});
afterEach(() => {
  clearCfBindings();
  vi.useRealTimers();
});

const never = () => false;
/** The production chain shape of app.ts: prefetch in place of the global limiter, body parser after it, API router at /api/v1. */
function appWith(router: express.Router, globalMax = 200, batched = true) {
  const app = express();
  app.set('trust proxy', 1);
  const jsonBody = express.json({ limit: '10mb' });
  const parseCookies = cookieParser();
  const global = security.plannedRateLimit('global', {
    windowMs: 15 * 60 * 1000,
    max: globalMax,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: (req: Request) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  });
  app.use(
    batched
      ? prefetchRequestLimits({
          global,
          router,
          mount: '/api/v1',
          jsonBody,
          prepare: copy => {
            if (copy.body && typeof copy.body === 'object')
              copy.body = security.sanitizedBody(copy.body);
            parseCookies(copy, {} as Response, () => undefined);
          },
        })
      : global
  );
  app.use(raiseHeldBodyError, jsonBody);
  app.use(parseCookies);
  app.use(security.sanitizeInput);
  app.use('/api/v1', router);
  app.use((err: { status?: number }, _req: Request, res: Response, _next: unknown) => {
    void _next;
    res.status(err.status ?? 500).json({ success: false, error: { code: 'BAD_BODY' } });
  });
  return app;
}

/** Sign-in: rl:global -> rl:auth-ip-fail -> rl:auth, the real limiter factories with the test-env skip turned off. */
function signInRouter(status = 401) {
  const router = express.Router();
  const ipFail = security.createAuthIpLimiter({
    countSuccess: false,
    prefix: 'auth-ip-fail',
    skip: never,
  });
  const auth = security.createAuthLimiter({ skip: never });
  router.post('/auth/login', ipFail, auth, (_req, res) => {
    res.status(status).json({ success: status < 400 });
  });
  return router;
}
const login = (app: express.Express, ip: string, email = 'a@b.c') =>
  request(app).post('/api/v1/auth/login').set('x-forwarded-for', ip).send({ email, password: 'x' });

describe('one AuthState round trip per shard', () => {
  it('sign-in: the 3 limiter hits are one call per shard, all in flight together', async () => {
    const app = appWith(signInRouter());
    expect((await login(app, '203.0.113.7')).status).toBe(401);
    const keys = [
      'rl:global:203.0.113.7',
      'rl:auth-ip-fail:203.0.113.7',
      'rl:auth:203.0.113.7-a@b.c',
    ];
    const shards = new Set(keys.map(shardOf));
    const calls = as.limiterCalls();
    expect(
      calls
        .map(c => c.ops.map(o => o[1]))
        .flat()
        .sort()
    ).toEqual([...keys].sort());
    expect(calls).toHaveLength(shards.size);
    expect(as.maxInFlight).toBe(shards.size);
  });

  it('the same chain WITHOUT the prefetch is sequential (what the test above catches)', async () => {
    const app = appWith(signInRouter(), 200, false);
    expect((await login(app, '203.0.113.8')).status).toBe(401);
    expect(as.limiterCalls()).toHaveLength(3);
    expect(as.maxInFlight).toBe(1);
  });

  it('two limiters on ONE shard (the public family of one client): their hits ride ONE call', async () => {
    const ipKey = (req: Request) => req.ip ?? 'noip';
    const opts = {
      windowMs: 60_000,
      max: 100,
      skip: never,
      keyGenerator: ipKey,
      passOnStoreError: true,
    };
    const a = security.plannedRateLimit('public', opts);
    const b = security.plannedRateLimit('public-search', opts);
    const router = express.Router();
    router.post('/public/thing', a, b, (_req, res) => {
      res.json({ ok: true });
    });
    const app = appWith(router);
    const res = await request(app)
      .post('/api/v1/public/thing')
      .set('x-forwarded-for', '198.51.100.4')
      .send({});
    expect(res.status).toBe(200);
    const onClient = as
      .limiterCalls()
      .filter(c => c.ops.some(o => String(o[1]).startsWith('rl:public:')));
    expect(onClient).toHaveLength(1);
    expect(onClient[0].ops.map(o => o[1])).toEqual([
      'rl:public:198.51.100.4',
      'rl:public-search:198.51.100.4',
    ]);
  });
});

describe('each limiter still trips at its own limit, with its own 429 body', () => {
  it('rl:auth (15 per IP + email): the 16th attempt is RATE_LIMITED "Too many login attempts"', async () => {
    const app = appWith(signInRouter());
    for (let i = 0; i < 15; i++) expect((await login(app, '203.0.113.20')).status).toBe(401);
    const res = await login(app, '203.0.113.20');
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('Too many login attempts, please try again later.');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('rl:auth-ip-fail (60 failures per IP, any email): the 61st is the network 429', async () => {
    const app = appWith(signInRouter());
    for (let i = 0; i < 60; i++)
      expect((await login(app, '203.0.113.21', `u${i}@b.c`)).status).toBe(401);
    const res = await login(app, '203.0.113.21', 'fresh@b.c');
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('Too many attempts from this network, try again later.');
  });

  it('rl:auth-ip-fail counts failures only: successful sign-ins never trip it', async () => {
    const app = appWith(signInRouter(200));
    for (let i = 0; i < 65; i++)
      expect((await login(app, '203.0.113.22', `u${i}@b.c`)).status).toBe(200);
  });

  it('rl:global (200 mutations per IP): the 201st is the global 429', async () => {
    const router = express.Router();
    router.post('/thing', (_req, res) => res.json({ ok: true }));
    const app = appWith(router);
    for (let i = 0; i < 200; i++)
      expect(
        (await request(app).post('/api/v1/thing').set('x-forwarded-for', '203.0.113.23').send({}))
          .status
      ).toBe(200);
    const res = await request(app)
      .post('/api/v1/thing')
      .set('x-forwarded-for', '203.0.113.23')
      .send({});
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('Too many requests, please try again later.');
  });

  it("a request refused by the global limiter does not keep the later limiters' prefetched hits", async () => {
    const app = appWith(signInRouter(), 1);
    expect((await login(app, '203.0.113.24')).status).toBe(401);
    expect((await login(app, '203.0.113.24')).status).toBe(429); // global, before the route limiters
    await new Promise(r => setTimeout(r, 50)); // the take-back runs after the response
    const store = new CfRateLimitStore('rl:auth:');
    store.init({ windowMs: 15 * 60 * 1000 } as never);
    expect((await store.get('203.0.113.24-a@b.c'))?.totalHits).toBe(1);
  });

  it('a malformed JSON body keeps its 400 at the parser, and an over-global request still gets the global 429 first', async () => {
    const app = appWith(signInRouter(), 1);
    const bad = () =>
      request(app)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', '203.0.113.25')
        .set('content-type', 'application/json')
        .send('{"email":');
    expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
  });
});

describe('a batched call that times out applies the strictest class among its members', () => {
  /** A fail-closed key that lands on the shard of `rl:public:10.200.9.9` (another client's write counter). */
  function closedKeyOnPublicShard(): string {
    const target = shardOf('rl:public:10.200.9.9');
    for (let i = 1; i < 5000; i++) {
      const key = `rl:write:10.${(i >> 8) & 255}.${i & 255}.1`;
      if (shardOf(key) === target) return key;
    }
    throw new Error('no key on that shard');
  }
  const stall = (key: string) => as.stuck.add(`shard-${shardOf(key)}`);

  it(
    'public key batched WITH a fail-closed key: a timeout fails the public key closed too',
    async () => {
      const ip = '10.200.9.9';
      stall(`rl:public:${ip}`);
      const hits = prefetchHits([
        { key: `rl:public:${ip}`, windowMs: 60_000 },
        { key: closedKeyOnPublicShard(), windowMs: 60_000 },
      ]);
      expect(as.calls).toHaveLength(1); // one call carried both
      const pub = new CfRateLimitStore('rl:public:');
      pub.init({ windowMs: 60_000 } as never);
      const res = await runWithPrefetchedHits(hits, () => pub.increment(ip));
      expect(res.totalHits).toBe(FAIL_CLOSED_HITS);
    },
    AUTH_STATE_TIMEOUT_MS + 5_000
  );

  it(
    'a batch of public read keys only: a timeout still fails open (the store error reaches the limiter)',
    async () => {
      const ip = '10.200.0.1';
      stall(`rl:public:${ip}`);
      const hits = prefetchHits([
        { key: `rl:public:${ip}`, windowMs: 60_000 },
        { key: `rl:public-tenant:${ip}`, windowMs: 60_000 },
      ]);
      const pub = new CfRateLimitStore('rl:public:');
      pub.init({ windowMs: 60_000 } as never);
      await expect(runWithPrefetchedHits(hits, () => pub.increment(ip))).rejects.toBeInstanceOf(
        AuthStateTimeoutError
      );
    },
    AUTH_STATE_TIMEOUT_MS + 5_000
  );

  it(
    'a fail-closed limiter in a timed-out batch answers its normal 429 (sign-in)',
    async () => {
      const app = appWith(signInRouter());
      stall('rl:auth:203.0.113.30-a@b.c');
      const res = await login(app, '203.0.113.30');
      expect(res.status).toBe(429);
      expect(res.body.error.message).toBe('Too many login attempts, please try again later.');
    },
    AUTH_STATE_TIMEOUT_MS + 5_000
  );
});

describe('every limiter of the API router is planned, or a named exception', () => {
  it('each express-rate-limit limiter carries a plan or a reason it counts directly', async () => {
    const routes = (await import('@api/routes')).default;
    const all = allLimiterHandles(routes);
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter(l => !l.planned && !l.noPlanReason)).toEqual([]);
    for (const l of all.filter(x => x.planned))
      expect(limitPlanOf(l.handle)?.windowMs).toBeGreaterThan(0);
  });
});
