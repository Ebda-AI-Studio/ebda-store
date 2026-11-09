/**
 * An ioredis-shaped client over Cloudflare primitives (R-EBDA-001, design section 5).
 *
 * `services/redis.service.ts` builds this instead of ioredis on Workers, so every one
 * of the ~40 call sites that use `redis.getClient()` keeps working unchanged. Routing
 * by key:
 *
 *   `cache:*`   -> KV_CACHE. Public payload caches: eventually consistent is fine,
 *                  KV's 60 s TTL floor is applied (the app's TTLs are >= 120 s).
 *   everything  -> AUTH_STATE Durable Object (strongly consistent, atomic, sharded):
 *   else           `jti:deny:*`, `user:tv:*`, `mfa:verify:*`, `lockout:*`, `csrf:*`,
 *                  `ratelimit:*`, `lock:*`, `leader:*`, sentinels, the dead-letter lists.
 *
 * Only the commands the API issues are implemented; anything else throws loudly rather
 * than silently doing nothing (a revocation that quietly no-ops is a security bug).
 * A pipeline / MULTI whose keys span shards runs one atomic batch per shard.
 */
import { cfBindings, type KVNamespaceLike } from './bindings';
import { hop } from '../lib/hop-timing';
import {
  applyOn,
  applyOnAll,
  applyOnShard,
  CACHEGEN_PREFIX,
  cachegenAnchor,
  cachegenHome,
  cachegenStoreShards,
  shardOf,
} from './auth-state-client';
import type { Op, SetOptions } from './auth-state-core';

const KV_PREFIX = 'cache:';
/** Workers KV rejects an expirationTtl below 60 s. */
const KV_MIN_TTL_S = 60;

type Handler = (...args: unknown[]) => void;

export interface CfRedisOptions {
  keyPrefix?: string;
}

function kv(): KVNamespaceLike {
  const ns = cfBindings()?.KV_CACHE;
  if (!ns) throw new Error('KV_CACHE binding is not configured');
  return new Proxy(ns, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      return typeof v === 'function'
        ? (...a: unknown[]) =>
            hop(`kv-${String(p)}`, async () => (v as (...x: unknown[]) => unknown).apply(t, a))
        : v;
    },
  });
}

/** Parse `SET key value [EX s|PX ms] [NX|XX] [KEEPTTL]` into DO options. */
export function parseSetArgs(args: unknown[]): SetOptions {
  const o: SetOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]).toUpperCase();
    if (a === 'EX') o.ttlMs = Number(args[++i]) * 1000;
    else if (a === 'PX') o.ttlMs = Number(args[++i]);
    else if (a === 'NX') o.nx = true;
    else if (a === 'XX') o.xx = true;
    else if (a === 'KEEPTTL') o.keepTtl = true;
    else throw new Error(`CfRedis: unsupported SET option ${a}`);
  }
  return o;
}

export class CfRedis {
  status: 'wait' | 'ready' | 'end' = 'wait';
  private readonly handlers = new Map<string, Handler[]>();
  private readonly prefix: string;

  constructor(opts: CfRedisOptions = {}) {
    this.prefix = opts.keyPrefix ?? '';
  }

  // ---------------------------------------------------------------- lifecycle

  on(event: string, fn: Handler): this {
    const l = this.handlers.get(event) ?? [];
    l.push(fn);
    this.handlers.set(event, l);
    return this;
  }
  once = this.on;

  private emit(event: string): void {
    for (const fn of this.handlers.get(event) ?? []) fn();
  }

  /** There is no socket to open: the bindings are ready as soon as the Worker is. */
  async connect(): Promise<void> {
    this.status = 'ready';
    this.emit('connect');
    this.emit('ready');
  }

  async quit(): Promise<'OK'> {
    this.status = 'end';
    this.emit('close');
    return 'OK';
  }
  async disconnect(): Promise<void> {
    await this.quit();
  }
  async ping(): Promise<'PONG'> {
    return 'PONG';
  }
  duplicate(): never {
    throw new Error('CfRedis: duplicate() (pub/sub) is not supported; realtime is StoreRealtime');
  }
  async call(): Promise<never> {
    throw new Error('CfRedis: call() is not supported; rate limits use cf/rate-limit-store.ts');
  }

  // ---------------------------------------------------------------- key routing

  private key(k: string): string {
    return this.prefix + k;
  }
  /** `cache:` keys (after the optional namespace prefix) live in KV. */
  private isKv(full: string): boolean {
    return full.startsWith(this.prefix + KV_PREFIX);
  }

  private async one(full: string, op: Op): Promise<unknown> {
    return (await applyOn(full, [op]))[0];
  }

  // ---------------------------------------------------------------- strings

  async get(k: string): Promise<string | null> {
    const full = this.key(k);
    if (this.isKv(full)) return kv().get(full);
    return (await this.one(full, ['get', full])) as string | null;
  }

  async set(k: string, v: string | number, ...args: unknown[]): Promise<'OK' | null> {
    const full = this.key(k);
    const o = parseSetArgs(args);
    if (this.isKv(full)) {
      if (o.nx || o.xx || o.keepTtl) throw new Error('CfRedis: NX/XX on a KV-routed key');
      const ttl =
        o.ttlMs === undefined ? undefined : Math.max(KV_MIN_TTL_S, Math.ceil(o.ttlMs / 1000));
      await kv().put(full, String(v), ttl === undefined ? undefined : { expirationTtl: ttl });
      return 'OK';
    }
    return (await this.one(full, ['set', full, String(v), o])) as 'OK' | null;
  }

  async setex(k: string, seconds: number, v: string | number): Promise<'OK'> {
    await this.set(k, v, 'EX', seconds);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      const full = this.key(k);
      if (this.isKv(full)) {
        const had = (await kv().get(full)) !== null;
        await kv().delete(full);
        if (had) n++;
      } else {
        n += (await this.one(full, ['del', full])) as number;
      }
    }
    return n;
  }
  unlink = this.del;

  async exists(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      const full = this.key(k);
      if (this.isKv(full)) n += (await kv().get(full)) !== null ? 1 : 0;
      else n += (await this.one(full, ['exists', full])) as number;
    }
    return n;
  }

  async expire(k: string, seconds: number): Promise<number> {
    return this.pexpire(k, seconds * 1000);
  }

  async pexpire(k: string, ms: number): Promise<number> {
    const full = this.key(k);
    if (this.isKv(full)) throw new Error('CfRedis: EXPIRE on a KV-routed key');
    return (await this.one(full, ['expire', full, ms])) as number;
  }

  async pttl(k: string): Promise<number> {
    const full = this.key(k);
    if (this.isKv(full)) throw new Error('CfRedis: PTTL on a KV-routed key');
    return (await this.one(full, ['pttl', full])) as number;
  }
  async ttl(k: string): Promise<number> {
    const ms = await this.pttl(k);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  }

  async incr(k: string): Promise<number> {
    const full = this.key(k);
    if (this.isKv(full)) throw new Error('CfRedis: INCR on a KV-routed key (not atomic)');
    return (await this.one(full, ['incr', full])) as number;
  }
  async decr(k: string): Promise<number> {
    const full = this.key(k);
    if (this.isKv(full)) throw new Error('CfRedis: DECR on a KV-routed key (not atomic)');
    return (await this.one(full, ['decr', full])) as number;
  }

  // ---------------------------------------------------------------- scan

  /**
   * `SCAN cursor MATCH prefix* COUNT n`: only the `prefix*` pattern shape the API uses.
   * Returns every match in one page (cursor '0'), without the namespace prefix, so the
   * caller's `unlink(...keys)` round-trips.
   */
  async scan(_cursor: string | number, ...args: unknown[]): Promise<[string, string[]]> {
    let pattern = '*';
    for (let i = 0; i < args.length; i += 2) {
      if (String(args[i]).toUpperCase() === 'MATCH') pattern = String(args[i + 1]);
    }
    if (!pattern.endsWith('*') || pattern.slice(0, -1).includes('*')) {
      throw new Error(`CfRedis: SCAN MATCH supports only 'prefix*' patterns, got ${pattern}`);
    }
    const prefix = this.prefix + pattern.slice(0, -1);
    const keys: string[] = [];
    if (prefix.startsWith(this.prefix + KV_PREFIX)) {
      let cursor: string | undefined;
      do {
        const page = await kv().list({ prefix, cursor, limit: 1000 });
        keys.push(...page.keys.map(x => x.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    } else {
      for (const part of await applyOnAll([['scan', prefix]]))
        keys.push(...((part[0] as string[]) ?? []));
    }
    return ['0', keys.map(x => x.slice(this.prefix.length))];
  }

  // ---------------------------------------------------------------- lists (dead-letter pages)

  async lpush(k: string, ...vs: string[]): Promise<number> {
    const full = this.key(k);
    return (await this.one(full, ['lpush', full, ...vs])) as number;
  }
  async rpop(k: string): Promise<string | null> {
    const full = this.key(k);
    return (await this.one(full, ['rpop', full])) as string | null;
  }
  async llen(k: string): Promise<number> {
    const full = this.key(k);
    return (await this.one(full, ['llen', full])) as number;
  }
  async lrange(k: string, start: number, stop: number): Promise<string[]> {
    const full = this.key(k);
    return (await this.one(full, ['lrange', full, start, stop])) as string[];
  }
  async ltrim(k: string, start: number, stop: number): Promise<'OK'> {
    const full = this.key(k);
    return (await this.one(full, ['ltrim', full, start, stop])) as 'OK';
  }

  // ---------------------------------------------------------------- scripts

  /**
   * The two Lua scripts the API ships, recognised by content and run as DO operations
   * (the DO is single-threaded, which is what the scripts were for): leader-election's
   * compare-and-delete and campaign-send-pacer's slot reservation.
   */
  async eval(script: string, numKeys: number, ...rest: unknown[]): Promise<unknown> {
    const keys = rest.slice(0, numKeys).map(String);
    const argv = rest.slice(numKeys).map(String);
    const full = this.key(keys[0] ?? '');
    if (script.includes("redis.call('TIME')") && script.includes('maxWait')) {
      return this.one(full, [
        'reserveSlot',
        full,
        Number(argv[0]),
        Number(argv[1]),
        Number(argv[2]),
      ]);
    }
    if (script.includes('redis.call("get", KEYS[1]) == ARGV[1]')) {
      return this.one(full, ['delIfEquals', full, argv[0]]);
    }
    throw new Error('CfRedis: EVAL supports only the two scripts the API ships');
  }

  // ---------------------------------------------------------------- cache generations (PERF-RL-DO)

  /**
   * Read the generations `names` (no `cachegen:` prefix) in ONE call per instance they live on: a store's names and the
   * replicated generic prefix names together on the store's shard (auth-state-client `cachegenHome`), so a cache fill or an
   * edge-hit check never touches a global instance.
   */
  async cacheGenerations(names: string[]): Promise<Array<string | null>> {
    const anchor = cachegenAnchor(names);
    const groups = new Map<number, number[]>();
    names.forEach((n, i) => {
      const shard = cachegenHome(n) ?? anchor;
      const list = groups.get(shard) ?? [];
      list.push(i);
      groups.set(shard, list);
    });
    const out = new Array<string | null>(names.length).fill(null);
    await Promise.all(
      [...groups].map(async ([shard, idx]) => {
        const res = await applyOnShard(
          shard,
          idx.map(i => ['get', this.key(CACHEGEN_PREFIX + names[i])] as Op)
        );
        idx.forEach((i, j) => (out[i] = (res[j] as string | null) ?? null));
      })
    );
    return out;
  }

  /** INCR + refresh the TTL of one generation: on its home shard, or on EVERY store shard for a replicated name. */
  async bumpCacheGeneration(name: string, ttlSeconds: number): Promise<void> {
    const full = this.key(CACHEGEN_PREFIX + name);
    const ops: Op[] = [
      ['incr', full],
      ['expire', full, ttlSeconds * 1000],
    ];
    const home = cachegenHome(name);
    await Promise.all(
      (home === null ? cachegenStoreShards() : [home]).map(shard => applyOnShard(shard, ops))
    );
  }

  // ---------------------------------------------------------------- pipelines

  multi(): CfPipeline {
    return new CfPipeline(this);
  }
  pipeline(): CfPipeline {
    return new CfPipeline(this);
  }

  /** @internal */
  async runBatch(
    steps: Array<{ cmd: string; args: unknown[] }>
  ): Promise<Array<[Error | null, unknown]>> {
    // Group consecutive steps by shard, run each shard's group as one atomic apply, keep order.
    const results: Array<[Error | null, unknown]> = new Array(steps.length);
    const byShard = new Map<number, Array<{ i: number; op: Op }>>();
    const direct: Array<{ i: number; run: () => Promise<unknown> }> = [];
    steps.forEach((s, i) => {
      const keyArg = String(s.args[0] ?? '');
      const full = this.key(keyArg);
      if (this.isKv(full)) {
        direct.push({
          i,
          run: () =>
            (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[s.cmd](
              ...s.args
            ),
        });
        return;
      }
      const op = this.toOp(s.cmd, full, s.args.slice(1));
      const shard = shardOf(full);
      const list = byShard.get(shard) ?? [];
      list.push({ i, op });
      byShard.set(shard, list);
    });
    await Promise.all([
      ...[...byShard.entries()].map(async ([, items]) => {
        try {
          const out = await applyOn(
            items[0].op[1] as string,
            items.map(x => x.op)
          );
          items.forEach((x, j) => (results[x.i] = [null, out[j]]));
        } catch (err) {
          items.forEach(x => (results[x.i] = [err as Error, undefined]));
        }
      }),
      ...direct.map(async d => {
        try {
          results[d.i] = [null, await d.run()];
        } catch (err) {
          results[d.i] = [err as Error, undefined];
        }
      }),
    ]);
    return results;
  }

  private toOp(cmd: string, full: string, rest: unknown[]): Op {
    switch (cmd) {
      case 'get':
      case 'incr':
      case 'decr':
      case 'pttl':
      case 'rpop':
      case 'llen':
        return [cmd, full];
      case 'del':
      case 'unlink':
      case 'exists':
        return [cmd === 'unlink' ? 'del' : cmd, full];
      case 'set':
        return ['set', full, String(rest[0]), parseSetArgs(rest.slice(1))];
      case 'setex':
        return ['set', full, String(rest[1]), { ttlMs: Number(rest[0]) * 1000 }];
      case 'expire':
        return ['expire', full, Number(rest[0]) * 1000];
      case 'pexpire':
        return ['expire', full, Number(rest[0])];
      case 'lpush':
        return ['lpush', full, ...rest.map(String)];
      default:
        throw new Error(`CfRedis: unsupported pipeline command ${cmd}`);
    }
  }
}

/** ioredis `Pipeline`/`Multi`: chainable, `exec()` resolves `[[err, result], ...]`. */
export class CfPipeline {
  private readonly steps: Array<{ cmd: string; args: unknown[] }> = [];
  constructor(private readonly client: CfRedis) {}

  private add(cmd: string, args: unknown[]): this {
    this.steps.push({ cmd, args });
    return this;
  }
  get(k: string) {
    return this.add('get', [k]);
  }
  set(k: string, v: string | number, ...a: unknown[]) {
    return this.add('set', [k, v, ...a]);
  }
  setex(k: string, s: number, v: string | number) {
    return this.add('setex', [k, s, v]);
  }
  del(...ks: string[]) {
    for (const k of ks) this.add('del', [k]);
    return this;
  }
  unlink(...ks: string[]) {
    for (const k of ks) this.add('unlink', [k]);
    return this;
  }
  exists(...ks: string[]) {
    for (const k of ks) this.add('exists', [k]);
    return this;
  }
  incr(k: string) {
    return this.add('incr', [k]);
  }
  expire(k: string, s: number) {
    return this.add('expire', [k, s]);
  }
  pexpire(k: string, ms: number) {
    return this.add('pexpire', [k, ms]);
  }
  lpush(k: string, ...vs: string[]) {
    return this.add('lpush', [k, ...vs]);
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    return this.client.runBatch(this.steps);
  }
}
