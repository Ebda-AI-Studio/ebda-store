/**
 * LAUNCH-RL-MISS (Ruling LAUNCH-RL-MISS-1): the two security halves of the store-miss limiter, in the unit tier so the
 * defence-mutation record can remove each one (docs/security/defence-mutations.json: `store-miss-refuses-at-limit`,
 * `store-miss-counts-a-404`).
 *
 * The limiter READS its counter before the handler and writes it only after a 404. This file pins what reaches the
 * counter store: one write per miss, none for a hit, none for a refusal, never a give-back. The same behaviour on the
 * runtime production uses (workerd, the AuthState Durable Object) is apps/api/workers-test/failure-only-limiters.test.ts.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Store } from 'express-rate-limit';
import { createStoreMissLimiter } from '@api/middleware/security';

const never = () => false;

function counterStore(resetInMs = 60_000) {
  const counts = new Map<string, number>();
  const writes: string[] = [];
  const store: Store = {
    init: () => undefined,
    get: async key => {
      const n = counts.get(key);
      return n ? { totalHits: n, resetTime: new Date(Date.now() + resetInMs) } : undefined;
    },
    increment: async key => {
      writes.push(`+${key}`);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { totalHits: n, resetTime: new Date(Date.now() + resetInMs) };
    },
    decrement: async key => {
      writes.push(`-${key}`);
    },
    resetKey: async key => {
      counts.delete(key);
    },
  };
  return { store, counts, writes };
}

function appWith(store: Store, max = 3) {
  const app = express();
  app.set('trust proxy', true);
  app.get('/stores/:slug', createStoreMissLimiter({ skip: never, max, store }), (req, res) =>
    req.params.slug === 'real' ? res.json({ ok: true }) : res.status(404).json({ ok: false })
  );
  return (slug: string, ip: string) =>
    request(app).get(`/stores/${slug}`).set('x-forwarded-for', ip);
}

describe('store-miss limiter: what reaches the counter', () => {
  it('a hit writes nothing; each miss is written once; the miss past the limit is refused and not written', async () => {
    const { store, counts, writes } = counterStore();
    const get = appWith(store);
    const ip = '9.2.0.1';

    for (let i = 0; i < 5; i++) expect((await get('real', ip)).status).toBe(200);
    expect(writes).toEqual([]);

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await get(`nope${i}`, ip);
      seen.push(`${r.status}:${r.headers['ratelimit-remaining']}`);
    }
    expect(seen).toEqual(['404:3', '404:2', '404:1', '429:0']);
    expect(writes).toEqual([`+${ip}`, `+${ip}`, `+${ip}`]);
    expect([...counts.values()]).toEqual([3]);

    // refused before the handler: the blocked client gets no more lookups, and a refusal is not a miss
    const blocked = await get('real', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(writes).toHaveLength(3);

    // another client is not affected
    expect((await get('nope', '9.2.0.2')).status).toBe(404);
  });

  it('a counter whose window already ended does not refuse', async () => {
    const { store, counts } = counterStore(-1_000);
    counts.set('9.2.0.3', 3);
    const get = appWith(store);
    expect((await get('real', '9.2.0.3')).status).toBe(200);
  });
});
