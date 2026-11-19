/**
 * #1862 — every rate limiter is built at MODULE LOAD, and `middleware/security`
 * is imported (via `./routes`) before `index.ts` runs `redis.connect()`. The
 * stores used to read `redis.getClient()` at construction time, got null, and
 * silently fell back to express-rate-limit's per-process MemoryStore: every
 * limit in production was per-replica and reset on every deploy.
 *
 * The redis service is mocked so this suite controls exactly what the limiters
 * see: DISCONNECTED when the module is imported (the boot order), connected
 * afterwards. Three properties are proven:
 *
 *  1. every limiter exported by security.ts reaches Redis once it connects,
 *     even though it was built while Redis was down (red on the old code: the
 *     fake client is never called);
 *  2. while Redis is not connected — boot, or an outage — a request is served
 *     IMMEDIATELY without touching the client (a client that never answers
 *     does not delay it), and the limit still applies per process;
 *  3. the same limiter switches to Redis once the connection is up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';

type Call = string[];
const state = vi.hoisted(() => ({
  available: false,
  client: null as null | { call: (...args: string[]) => Promise<unknown>; calls: Call[] },
}));

const alerts = vi.hoisted(() => ({ sendAlert: vi.fn().mockResolvedValue('sent') }));
vi.mock('@api/services/alerts.service', () => alerts);
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: log }));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => state.available,
    getClient: () => state.client,
  },
}));

import * as security from '@api/middleware/security';
import { makeRateLimitStore, rateLimitRedisClient } from '@api/middleware/security';
import { recordRateLimited, resetRateLimitTelemetry } from '@api/lib/rate-limit-telemetry';

/** A working Redis double that speaks just enough of rate-limit-redis's protocol. */
function workingRedis() {
  const calls: Call[] = [];
  const hits = new Map<string, number>();
  return {
    calls,
    call: (...args: string[]) => {
      calls.push(args);
      const cmd = String(args[0]).toUpperCase();
      if (cmd === 'SCRIPT') return Promise.resolve('sha-fake');
      if (cmd === 'EVALSHA') {
        const key = args[3];
        // Increment script carries 2 ARGV (resetOnChange, windowMs); get carries none.
        if (args.length > 4) hits.set(key, (hits.get(key) ?? 0) + 1);
        return Promise.resolve([hits.get(key) ?? 0, 60_000]);
      }
      return Promise.resolve(null);
    },
  };
}

/** A client that exists but never answers — ioredis queueing on a connecting socket. */
function hangingRedis() {
  const calls: Call[] = [];
  return {
    calls,
    call: (...args: string[]) => {
      calls.push(args);
      return new Promise<unknown>(() => undefined);
    },
  };
}

function limiters(): Array<[string, { getKey: (k: string) => Promise<unknown> }]> {
  return Object.entries(security).filter(
    ([name, v]) =>
      /Limiter$/.test(name) &&
      typeof v === 'function' &&
      typeof (v as { getKey?: unknown }).getKey === 'function'
  ) as Array<[string, { getKey: (k: string) => Promise<unknown> }]>;
}

beforeEach(() => {
  state.available = false;
  state.client = null;
});

describe('#1862 rate limiters built before redis.connect() still use Redis', () => {
  it('finds the limiters it is checking (guards against an empty loop)', () => {
    expect(limiters().length).toBeGreaterThanOrEqual(15);
  });

  it('every exported limiter reaches Redis once Redis is connected', async () => {
    const fake = workingRedis();
    state.client = fake;
    state.available = true;

    for (const [name, limiter] of limiters()) {
      const before = fake.calls.length;
      await limiter.getKey(`probe-${name}`);
      const evals = fake.calls
        .slice(before)
        .filter(
          c => c[0] === 'EVALSHA' && c[3]?.startsWith('rl:') && c[3].endsWith(`probe-${name}`)
        );
      expect(evals.length, `${name} did not reach Redis — it is counting in process memory`).toBe(
        1
      );
    }
  });
});

describe('#1862 a request never waits on Redis', () => {
  function appWith(max: number) {
    const app = express();
    app.use(
      rateLimit({
        windowMs: 60_000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        passOnStoreError: true,
        store: makeRateLimitStore(rateLimitRedisClient, `boot-test-${Math.random()}`),
      })
    );
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('serves immediately, without calling the client, while Redis is still connecting', async () => {
    const hanging = hangingRedis();
    state.client = hanging; // client object exists (connect() has started)...
    state.available = false; // ...but is not connected yet
    const app = appWith(2);

    const started = Date.now();
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hanging.calls).toHaveLength(0);
  }, 5_000);

  it('still limits (per process) while Redis is unavailable, then moves to Redis', async () => {
    const app = appWith(2);

    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);

    const fake = workingRedis();
    state.client = fake;
    state.available = true;
    // Redis's own counter for this key starts at zero, so the request is served
    // and — the point — it was counted in Redis.
    expect((await request(app).get('/ping')).status).toBe(200);
    expect(fake.calls.some(c => c[0] === 'EVALSHA')).toBe(true);
  });
});

describe('#1862 source gate — every limiter in apps/api/src resolves Redis lazily', () => {
  it('each rateLimit({ config carries a lazily-resolved shared store', () => {
    const root = path.resolve(process.cwd(), 'apps/api/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(p);
        } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    let total = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const configs = src.match(/rateLimit\(\{/g)?.length ?? 0;
      // PERF-BATCH-1: `plannedRateLimit('<name>', ...)` builds its store with
      // makeRateLimitStore(rateLimitRedisClient, name) itself (security.ts), so each call site is a lazy limiter too.
      total += src.match(/plannedRateLimit\(['`]/g)?.length ?? 0;
      if (!configs) continue;
      total += configs;
      const rel = path.relative(process.cwd(), file);
      const lazyStores =
        src.match(/store: makeRateLimitStore\(rateLimitRedisClient, /g)?.length ?? 0;
      expect(
        lazyStores,
        `${rel}: every rateLimit({ needs store: makeRateLimitStore(rateLimitRedisClient, …)`
      ).toBe(configs);
      expect(src, `${rel}: redis.getClient() read at module load is the #1862 defect`).not.toMatch(
        /makeRateLimitStore\(redis\.getClient\(\)/
      );
    }
    expect(total).toBeGreaterThanOrEqual(19);
  });
});

/**
 * issue 1963 / issue 2216 / issue 2230 — the limiters are observable and have
 * a kill switch. Mutation-proof: dropping `recordMemoryFallback` from
 * RedisOrMemoryStore.current() reddens "announces a fallback"; dropping the
 * `recordRateLimited` call from increment() reddens "counts 429s per limiter";
 * dropping `rateLimitSharedEnabled()` from rateLimitRedisClient reddens the
 * kill-switch case.
 */
describe('rate limiter observability + kill switch', () => {
  function appWith(max: number, name: string) {
    const app = express();
    app.use(
      rateLimit({
        windowMs: 60_000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        passOnStoreError: true,
        store: makeRateLimitStore(rateLimitRedisClient, name),
      })
    );
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  beforeEach(() => {
    resetRateLimitTelemetry(Date.now());
    alerts.sendAlert.mockClear();
    log.warn.mockClear();
    delete process.env.RATE_LIMIT_SHARED;
  });

  it('announces a fallback to per-process counting after a Redis-backed period (once)', async () => {
    const app = appWith(100, `obs-fallback-${Math.random()}`);
    state.client = workingRedis();
    state.available = true;
    expect((await request(app).get('/ping')).status).toBe(200);
    state.available = false; // Redis drops
    await request(app).get('/ping');
    await request(app).get('/ping');
    const fallbackAlerts = alerts.sendAlert.mock.calls.filter(
      c => (c[0] as { source: string }).source === 'rate-limit.memory-fallback'
    );
    expect(fallbackAlerts).toHaveLength(1);
  });

  it('counts 429s per limiter prefix and summarises them once the window turns over', async () => {
    const name = `obs-429-${Math.random()}`;
    const app = appWith(1, name);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);
    expect((await request(app).get('/ping')).status).toBe(429);
    // Next event after the 60s window flushes the summary.
    recordRateLimited('rl:other:', Date.now() + 61_000);
    const summary = log.warn.mock.calls.find(
      c => c[1] === '[rate-limit] 429s by limiter in the last window'
    );
    expect(summary?.[0]).toMatchObject({ rateLimited: { [`rl:${name}:`]: 2 } });
  });

  it('RATE_LIMIT_SHARED=0 keeps Redis connected but counts per process', async () => {
    process.env.RATE_LIMIT_SHARED = '0';
    const fake = workingRedis();
    state.client = fake;
    state.available = true;
    const app = appWith(5, `obs-kill-${Math.random()}`);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect(fake.calls.filter(c => c[0] === 'EVALSHA')).toHaveLength(0);
    delete process.env.RATE_LIMIT_SHARED;
  });
});
