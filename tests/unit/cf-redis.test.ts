/**
 * The ioredis-shaped client used on Workers (apps/api/src/cf/ioredis-cf.ts): key routing between the
 * AuthState Durable Object and KV, the pipeline, the two shipped Lua scripts, and the refusals.
 * The Durable Object here is the real command engine over node:sqlite, one database per shard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CfRedis, parseSetArgs } from '@api/cf/ioredis-cf';
import { AuthStateStore, type Op } from '@api/cf/auth-state-core';
import { AUTH_STATE_SHARDS, fnv1a, shardKey, shardOf } from '@api/cf/auth-state-client';
import { clearCfBindings, setCfBindings, type CfBindings } from '@api/cf/bindings';
import { createSqlite } from '../helpers/sqlite-sql';

class FakeAuthStateNamespace {
  readonly stores = new Map<string, AuthStateStore>();
  readonly calls: Array<{ shard: string; ops: Op[] }> = [];
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
        return ops.map(op => store.run(op, Date.now()));
      },
    } as never;
  }
}

class FakeKv {
  readonly data = new Map<string, { v: string; ttl?: number }>();
  async get(k: string) {
    return this.data.get(k)?.v ?? null;
  }
  async put(k: string, v: string, o?: { expirationTtl?: number }) {
    this.data.set(k, { v, ttl: o?.expirationTtl });
  }
  async delete(k: string) {
    this.data.delete(k);
  }
  async list(o?: { prefix?: string }) {
    const keys = [...this.data.keys()]
      .filter(k => k.startsWith(o?.prefix ?? ''))
      .map(name => ({ name }));
    return { keys, list_complete: true };
  }
}

let ns: FakeAuthStateNamespace;
let kv: FakeKv;
let redis: CfRedis;

beforeEach(() => {
  ns = new FakeAuthStateNamespace();
  kv = new FakeKv();
  setCfBindings({
    AUTH_STATE: ns,
    KV_CACHE: kv,
  } as unknown as CfBindings);
  redis = new CfRedis();
});
afterEach(() => clearCfBindings());

describe('routing', () => {
  it('cache:* goes to KV and nothing else touches the Durable Object', async () => {
    await redis.set('cache:store:slug:alpha', '{"id":1}', 'EX', 120);
    expect(await redis.get('cache:store:slug:alpha')).toBe('{"id":1}');
    expect(kv.data.get('cache:store:slug:alpha')?.ttl).toBe(120);
    expect(ns.calls).toHaveLength(0);
  });

  it("KV's 60 s TTL floor is applied to a shorter request", async () => {
    await redis.setex('cache:short', 10, 'v');
    expect(kv.data.get('cache:short')?.ttl).toBe(60);
  });

  it('everything else is strongly consistent state on the Durable Object', async () => {
    await redis.set('jti:deny:abc', '1', 'EX', 60);
    expect(await redis.exists('jti:deny:abc')).toBe(1);
    expect(kv.data.size).toBe(0);
    expect(ns.calls.length).toBeGreaterThan(0);
  });

  it('the namespace prefix (REDIS_KEY_PREFIX) applies to both stores and is stripped from SCAN results', async () => {
    const p = new CfRedis({ keyPrefix: 'staging:' });
    await p.set('cache:a', '1');
    await p.set('jti:deny:z', '1');
    expect([...kv.data.keys()]).toEqual(['staging:cache:a']);
    expect(await p.scan('0', 'MATCH', 'cache:*')).toEqual(['0', ['cache:a']]);
  });

  it('a key always lands on the same shard, and the lockout keys of one account share it', () => {
    expect(shardOf('jti:deny:abc')).toBe(shardOf('jti:deny:abc'));
    const id = 'lockout:someone@example.com';
    expect(shardOf(`${id}:attempts`)).toBe(shardOf(`${id}:locked`));
    expect(shardKey('lockout:x:attempts')).toBe('lockout:x');
    expect(shardKey('mfa:verify:attempts:jti1')).toBe('mfa:verify:attempts:jti1'); // only a TRAILING suffix
  });

  it('shard assignment is pinned: it must never move between releases (state would be orphaned)', () => {
    expect(AUTH_STATE_SHARDS).toBe(32);
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(shardOf('jti:deny:abc')).toBe(fnv1a('jti:deny:abc') % 32);
    expect(fnv1a('user:tv:11111111-1111-4111-8111-111111111111') % 32).toBe(
      shardOf('user:tv:11111111-1111-4111-8111-111111111111')
    );
  });

  it('keys spread over the shards (no hot shard from a bad hash)', () => {
    const hit = new Set<number>();
    for (let i = 0; i < 2000; i++) hit.add(shardOf(`jti:deny:${i}`));
    expect(hit.size).toBe(32);
  });
});

describe('the Redis surface the API uses', () => {
  it('revocation: deny a jti, check it, set / read / clear a token version', async () => {
    await redis.setex('jti:deny:abc', 60, '1');
    expect(await redis.exists('jti:deny:abc')).toBe(1);
    await redis.set('user:tv:u1', '4');
    expect(Number(await redis.get('user:tv:u1'))).toBe(4);
    expect(await redis.del('user:tv:u1')).toBe(1);
    expect(await redis.get('user:tv:u1')).toBeNull();
  });

  it('lockout: INCR then PEXPIRE on the first attempt, lock with SET ... PX', async () => {
    expect(await redis.incr('lockout:a@b:attempts')).toBe(1);
    await redis.pexpire('lockout:a@b:attempts', 900_000);
    expect(await redis.incr('lockout:a@b:attempts')).toBe(2);
    expect(await redis.set('lockout:a@b:locked', '123', 'PX', 5000)).toBe('OK');
    expect(await redis.get('lockout:a@b:locked')).toBe('123');
  });

  it('SET ... EX .. NX is a mutex (leader lock, lock:*, sentinels)', async () => {
    expect(await redis.set('lock:x', '1', 'EX', 30, 'NX')).toBe('OK');
    expect(await redis.set('lock:x', '1', 'EX', 30, 'NX')).toBeNull();
  });

  it('parseSetArgs understands EX / PX / NX / XX / KEEPTTL and refuses anything else', () => {
    expect(parseSetArgs(['EX', 30, 'NX'])).toEqual({ ttlMs: 30_000, nx: true });
    expect(parseSetArgs(['PX', 250, 'XX'])).toEqual({ ttlMs: 250, xx: true });
    expect(parseSetArgs(['KEEPTTL'])).toEqual({ keepTtl: true });
    expect(() => parseSetArgs(['GET'])).toThrow(/unsupported SET option/);
  });

  it('SCAN MATCH prefix* + UNLINK is the cache-bust sweep, on KV', async () => {
    await redis.set('cache:public:products:s1:a', '1');
    await redis.set('cache:public:products:s1:b', '1');
    await redis.set('cache:public:products:s2:a', '1');
    const [cursor, keys] = await redis.scan(
      '0',
      'MATCH',
      'cache:public:products:s1:*',
      'COUNT',
      200
    );
    expect(cursor).toBe('0');
    await redis.unlink(...keys);
    expect([...kv.data.keys()]).toEqual(['cache:public:products:s2:a']);
  });

  it('SCAN refuses a pattern shape it cannot honour', async () => {
    await expect(redis.scan('0', 'MATCH', 'a*b*')).rejects.toThrow(/prefix\*/);
  });

  it('lists back the dead-letter pages', async () => {
    await redis.lpush('email:failed', 'a');
    await redis.lpush('email:failed', 'b');
    expect(await redis.llen('email:failed')).toBe(2);
    expect(await redis.lrange('email:failed', 0, 9)).toEqual(['b', 'a']);
    expect(await redis.rpop('email:failed')).toBe('a');
    await redis.ltrim('email:failed', 0, 0);
    expect(await redis.llen('email:failed')).toBe(1);
  });

  it('connect() makes it ready (status + events) with no socket to open', async () => {
    const seen: string[] = [];
    redis.on('connect', () => seen.push('connect')).on('ready', () => seen.push('ready'));
    expect(redis.status).toBe('wait');
    await redis.connect();
    expect(redis.status).toBe('ready');
    expect(seen).toEqual(['connect', 'ready']);
    await redis.quit();
    expect(redis.status).toBe('end');
  });
});

describe('pipelines (MULTI incr + expire)', () => {
  it('runs in order and returns [[err, result], ...] like ioredis', async () => {
    const res = await redis
      .multi()
      .incr('mfa:verify:attempts:j')
      .expire('mfa:verify:attempts:j', 300)
      .exec();
    expect(res).toEqual([
      [null, 1],
      [null, 1],
    ]);
    expect(await redis.get('mfa:verify:attempts:j')).toBe('1');
  });

  it('keys of one account stay on one shard, so one atomic batch', async () => {
    ns.calls.length = 0;
    await redis.pipeline().del('lockout:a@b:attempts').del('lockout:a@b:locked').exec();
    expect(ns.calls).toHaveLength(1);
    expect(ns.calls[0].ops).toHaveLength(2);
  });

  it('sentinel claims: SET NX pipeline returns OK / null per key', async () => {
    const claim = () =>
      redis.pipeline().set('low-stock-alerted:s:p', 'pending', 'EX', 60, 'NX').exec();
    expect((await claim())[0]).toEqual([null, 'OK']);
    expect((await claim())[0]).toEqual([null, null]);
  });
});

describe('the shipped Lua scripts', () => {
  it("leader-election's compare-and-delete", async () => {
    await redis.set('leader:job', 'me', 'EX', 30, 'NX');
    const lua =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    expect(await redis.eval(lua, 1, 'leader:job', 'someone-else')).toBe(0);
    expect(await redis.eval(lua, 1, 'leader:job', 'me')).toBe(1);
  });

  it('the campaign pacer reserves consecutive slots', async () => {
    const lua = "local t = redis.call('TIME') ... maxWait ...";
    const first = (await redis.eval(
      lua,
      1,
      'campaign:send-pacer:next-slot',
      '1000',
      '300000',
      '-1'
    )) as number[];
    const second = (await redis.eval(
      lua,
      1,
      'campaign:send-pacer:next-slot',
      '1000',
      '300000',
      '-1'
    )) as number[];
    expect(first[1]).toBe(1);
    expect(second[0]).toBeGreaterThan(first[0]);
  });

  it('any other script is refused, not silently skipped', async () => {
    await expect(redis.eval('return 1', 0)).rejects.toThrow(/only the two scripts/);
  });
});

describe('refusals (a revocation that quietly no-ops is a security bug)', () => {
  it('duplicate() (pub/sub) and call() are not supported', async () => {
    expect(() => redis.duplicate()).toThrow(/realtime is StoreRealtime/);
    await expect(redis.call()).rejects.toThrow(/rate-limit-store/);
  });

  it('atomic commands on a KV-routed key are refused', async () => {
    await expect(redis.incr('cache:counter')).rejects.toThrow(/not atomic/);
    await expect(redis.set('cache:k', 'v', 'NX')).rejects.toThrow(/NX\/XX/);
  });

  it('without the bindings every command fails loudly (callers fail open or surface it)', async () => {
    clearCfBindings();
    await expect(redis.get('jti:deny:a')).rejects.toThrow(/AUTH_STATE/);
    await expect(redis.get('cache:a')).rejects.toThrow(/KV_CACHE/);
  });
});
