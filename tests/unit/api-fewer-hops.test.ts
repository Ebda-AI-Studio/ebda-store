// The DO-hop reductions keep every guard in force: both public limiters still run on every request
// and either can block; cache-generation keys share one Durable Object shard; every other key
// keeps the shard it always had (a shard assignment must never move).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inParallel } from '../../apps/api/src/lib/run-in-parallel';
import {
  fnv1a,
  shardKey,
  shardOf,
  AUTH_STATE_SHARDS,
  CACHEGEN_SHARD,
} from '../../apps/api/src/cf/auth-state-client';
import { generationNamesFor } from '../../apps/api/src/lib/public-cache';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

function drive(mw: ReturnType<typeof inParallel>) {
  const calls = { next: 0, err: undefined as unknown };
  const res = { sent: false };
  return new Promise<{ next: number; err: unknown; res: typeof res }>(resolve => {
    mw({} as any, res as any, (e?: unknown) => {
      calls.next++;
      calls.err = e;
    });
    setTimeout(() => resolve({ next: calls.next, err: calls.err, res }), 60);
  });
}

describe('inParallel: every limiter runs, all must pass', () => {
  it('runs every middleware on every request', async () => {
    const ran: string[] = [];
    const mk = (n: string, ms: number) => (_q: any, _r: any, next: any) =>
      void tick(ms).then(() => (ran.push(n), next()));
    const out = await drive(inParallel(mk('ip', 5), mk('tenant', 20)));
    expect(ran.sort()).toEqual(['ip', 'tenant']);
    expect(out.next).toBe(1);
  });
  it('waits for ALL of them before continuing (does not proceed on the first)', async () => {
    let slowDone = false;
    const fast = (_q: any, _r: any, next: any) => next();
    const slow = (_q: any, _r: any, next: any) =>
      void tick(30).then(() => ((slowDone = true), next()));
    let nextAt = false;
    await new Promise<void>(resolve =>
      inParallel(fast, slow)({} as any, {} as any, () => {
        nextAt = slowDone;
        resolve();
      })
    );
    expect(nextAt).toBe(true);
  });
  it.each([0, 1])(
    'a blocking limiter (index %i answers 429, never calls next) stops the request',
    async i => {
      const pass = (_q: any, _r: any, next: any) => void tick(5).then(() => next());
      const block = (_q: any, r: any) => void tick(10).then(() => (r.sent = true));
      const mws = i === 0 ? [block, pass] : [pass, block];
      const out = await drive(inParallel(...(mws as any)));
      expect(out.res.sent).toBe(true);
      expect(out.next).toBe(0);
    }
  );
  it('a middleware error is forwarded once and stops the chain', async () => {
    const boom = (_q: any, _r: any, next: any) => next(new Error('x'));
    const pass = (_q: any, _r: any, next: any) => void tick(5).then(() => next());
    const out = await drive(inParallel(boom, pass));
    expect(out.next).toBe(1);
    expect((out.err as Error).message).toBe('x');
  });
  it('a synchronous throw is forwarded as an error', async () => {
    const out = await drive(
      inParallel(() => {
        throw new Error('sync');
      })
    );
    expect((out.err as Error).message).toBe('sync');
  });
});

describe('the public router still mounts BOTH limiters', () => {
  const src = readFileSync(join(__dirname, '../../apps/api/src/routes/public.routes.ts'), 'utf8');
  it('per-IP and per-tenant limiters are both in the parallel group', () => {
    expect(src).toContain('inParallel(publicLimiter, publicTenantLimiter)');
  });
  it('no bare router-level publicLimiter is left behind', () => {
    expect(src).not.toMatch(/^router\.use\(publicLimiter\)/m);
  });
});

describe('cache-generation keys have their OWN Durable Object, never an auth shard', () => {
  it('every generation name of a key with no store id routes to the one base cachegen instance', () => {
    for (const key of ['public:categories:abc', 'public:products:s1:feed:v2']) {
      const shards = new Set(generationNamesFor(key).map(n => shardOf(`cachegen:${n}`)));
      expect([...shards]).toEqual([CACHEGEN_SHARD]);
    }
  });
  it('a store-scoped key spans the base instance plus exactly ONE store shard (NZ-D3: at most two calls per fill)', () => {
    for (const key of [
      'public:products:11111111-1111-4111-8111-111111111111:feed:v2',
      'public:store:resolve:h.ebda.app',
    ]) {
      const shards = new Set(generationNamesFor(key).map(n => shardOf(`cachegen:${n}`)));
      expect(shards.has(CACHEGEN_SHARD)).toBe(true);
      expect(shards.size).toBe(2);
      expect([...shards].every(x => x <= CACHEGEN_SHARD)).toBe(true);
    }
  });
  it('the cachegen instance is outside the auth shard range, and no auth key can route to it', () => {
    expect(CACHEGEN_SHARD < 0 || CACHEGEN_SHARD >= AUTH_STATE_SHARDS).toBe(true);
    for (const k of [
      'jti:deny:abc',
      'user:tv:x',
      'csrf:tok',
      'rl:public:1.2.3.4',
      'mfa:verify:attempts:j1',
      'lockout:a@b:attempts',
      'leader:x',
      'lock:y',
      'cachegenx',
      'jti:deny:cachegen:1',
    ]) {
      const s = shardOf(k);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(AUTH_STATE_SHARDS);
    }
  });
  it('auth-critical keys keep exactly the shard they had before (hash of the key itself)', () => {
    for (const k of [
      'jti:deny:abc',
      'user:tv:11111111-1111-4111-8111-111111111111',
      'csrf:tok',
      'rl:public:1.2.3.4',
      'mfa:verify:attempts:j1',
    ])
      expect(shardOf(k)).toBe(fnv1a(shardKey(k)) % AUTH_STATE_SHARDS);
    expect(shardKey('lockout:x:attempts')).toBe('lockout:x');
    expect(shardOf('lockout:x:attempts')).toBe(shardOf('lockout:x:locked'));
  });
  it('the client addresses the instance by name "cachegen" and sweeps include it', () => {
    const src = readFileSync(join(__dirname, '../../apps/api/src/cf/auth-state-client.ts'), 'utf8');
    expect(src).toContain('shard === CACHEGEN_SHARD');
    expect(src).toContain('cachegenPlacement()');
    expect(src).toContain('stub(CACHEGEN_SHARD).apply(ops)');
  });
});
