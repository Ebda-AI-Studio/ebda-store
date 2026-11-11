/**
 * Per-request I/O tally (PERF-LATENCY, 2026-11-09): how many calls a request made to each remote binding and how long they
 * took, so `Server-Timing` shows WHERE a slow request waited (BE:E-1 only split auth / identity / handler; a 400 ms cart add
 * looked like one opaque `handler`).
 *
 * The bindings recorded by `setCfBindings` are wrapped ONCE per env object ({@link instrumentBindings}): D1 statements, the
 * StoreDO, the AuthState DO, the other DOs, the identity service binding (`accounts`) and KV. A call is tallied only inside a request that
 * opened a tally ({@link runWithIoTally}, the `serverTiming` middleware), so queues, crons and DO alarms pay nothing. The
 * wrappers only OBSERVE: the original call is made with the original receiver and its own return value is handed back (an RPC
 * promise keeps its pipelining; a D1 statement handed to `batch` is unwrapped first).
 *
 * The tally also backs the call-count budgets (`workers-test/latency-budget.test.ts`, NEON-SCALE-1 "a test that counts calls").
 * `ms` sums durations, so calls made in parallel add up to more than the wall time they cost.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const IO_KINDS = ['d1', 'store-do', 'auth-state', 'do-other', 'accounts', 'kv'] as const;
export type IoKind = (typeof IO_KINDS)[number];
export interface IoTally {
  n: Record<IoKind, number>;
  ms: Record<IoKind, number>;
  /**
   * Serial round trips: a call that starts while no other tallied call is in flight opens a new wave; calls started while one
   * is in flight join it. Parallel calls (Promise.all) therefore cost one wave, a chain of awaits one wave each.
   */
  waves: number;
  inflight: number;
  /** Test / local dev only (DEV_STATS=1): the op labels in call order, for finding what to batch. */
  ops?: string[];
  /** Test / local dev only (DEV_STATS=1): injected AuthState latency / stall (cf/auth-state-client.ts `call`). */
  authStateFault?: { delayMs: number; stall: string };
  /** Test / local dev only (DEV_STATS=1): injected StoreDO round-trip latency (PERF-BATCH-1 measurements, `wrapCalls`). */
  storeDoDelayMs?: number;
}

const als = new AsyncLocalStorage<IoTally>();

export function newIoTally(): IoTally {
  const zero = () => Object.fromEntries(IO_KINDS.map(k => [k, 0])) as Record<IoKind, number>;
  return { n: zero(), ms: zero(), waves: 0, inflight: 0 };
}

export function runWithIoTally<T>(tally: IoTally, fn: () => T): T {
  return als.run(tally, fn);
}

export function currentIoTally(): IoTally | undefined {
  return als.getStore();
}

/** Tally one call. Returns `value` itself (never a new promise), so an RPC promise keeps its pipelining. */
function tally<T>(kind: IoKind, start: () => T, label = ''): T {
  const t = als.getStore();
  if (!t) return start();
  t.n[kind]++;
  t.ops?.push(`${kind}:${label}`);
  if (t.inflight === 0) t.waves++;
  t.inflight++;
  const t0 = performance.now();
  const done = () => {
    t.inflight--;
    t.ms[kind] += performance.now() - t0;
  };
  const value = start();
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    (value as unknown as Promise<unknown>).then(done, done);
  } else done();
  return value;
}

/** Props that must pass through untouched: thenable probing, RPC stub lifecycle, symbols. */
const PASS = new Set<PropertyKey>(['then', 'constructor', 'dup', 'toJSON']);

function wrapCalls<T extends object>(target: T, kind: IoKind, instance = ''): T {
  return new Proxy(target, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof p === 'symbol' || PASS.has(p) || typeof v !== 'function') return v;
      return (...args: unknown[]) =>
        tally(
          kind,
          () => {
            const delay = kind === 'store-do' ? als.getStore()?.storeDoDelayMs : undefined;
            if (!delay) return Reflect.apply(v, t, args);
            return new Promise(r => setTimeout(r, delay)).then(() => Reflect.apply(v, t, args));
          },
          `${instance ? `@${instance}:` : ''}${String(p)}:${labelArgs(args)}`
        );
    },
  });
}
function labelArgs(args: unknown[]): string {
  return args
    .slice(0, 3)
    .map(a =>
      typeof a === 'string'
        ? a.slice(0, 40)
        : Array.isArray(a)
          ? JSON.stringify(a).slice(0, 80)
          : typeof a
    )
    .join('|');
}

/**
 * A Durable Object namespace whose stubs tally every method call (`fetch` included). The op label carries the instance NAME
 * (`@shard-3:`, `@cachegen-s12:`) when the stub came from `idFromName` / `getByName`, so a test can see which instance a call hit.
 */
function wrapNamespace<T extends object>(ns: T, kind: IoKind): T {
  const names = new WeakMap<object, string>();
  return new Proxy(ns, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === 'idFromName' && typeof v === 'function') {
        return (...args: unknown[]) => {
          const id = Reflect.apply(v, t, args) as unknown;
          if (id && typeof id === 'object') names.set(id, String(args[0]));
          return id;
        };
      }
      if ((p === 'get' || p === 'getByName') && typeof v === 'function') {
        return (...args: unknown[]) => {
          const stub = Reflect.apply(v, t, args) as object;
          const a0 = args[0];
          const instance =
            p === 'getByName'
              ? String(a0)
              : a0 && typeof a0 === 'object'
                ? (names.get(a0) ?? '')
                : '';
          return stub && typeof stub === 'object' ? wrapCalls(stub, kind, instance) : stub;
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const RAW = new WeakMap<object, object>();
const unwrap = (s: unknown): unknown => (s && typeof s === 'object' && RAW.get(s)) || s;

/** A D1 prepared statement: `bind` keeps the wrapper, `first/all/run/raw` are tallied. */
function wrapStatement(stmt: object, sql = ''): object {
  const w = new Proxy(stmt, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      if (p === 'bind')
        return (...args: unknown[]) => wrapStatement(Reflect.apply(v, t, args), sql);
      if (p === 'first' || p === 'all' || p === 'run' || p === 'raw')
        return (...args: unknown[]) =>
          tally('d1', () => Reflect.apply(v, t, args), sql.slice(0, 70));
      return v.bind(t);
    },
  });
  RAW.set(w, stmt);
  return w;
}

/** A D1 database (or a `withSession` session): statements wrapped, `batch` / `exec` tallied as ONE call. */
function wrapD1(db: object): object {
  return new Proxy(db, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      if (p === 'prepare')
        return (...args: unknown[]) =>
          wrapStatement(Reflect.apply(v, t, args) as object, String(args[0]));
      if (p === 'batch')
        return (stmts: unknown[], ...rest: unknown[]) =>
          tally('d1', () => Reflect.apply(v, t, [stmts.map(unwrap), ...rest]));
      if (p === 'exec') return (...args: unknown[]) => tally('d1', () => Reflect.apply(v, t, args));
      if (p === 'withSession')
        return (...args: unknown[]) => wrapD1(Reflect.apply(v, t, args) as object);
      return v.bind(t);
    },
  });
}

const DO_KIND: Record<string, IoKind> = {
  STORE_DO: 'store-do',
  AUTH_STATE: 'auth-state',
  STORE_REALTIME: 'do-other',
  JOB_GATE: 'do-other',
  STORE_SCHEDULE: 'do-other',
};

const instrumented = new WeakMap<object, object>();

/**
 * The env with its remote bindings tallied. Memoised per env object, so `prepare()` on every request wraps once per isolate.
 * Anything not listed is the same object as before.
 */
export function instrumentBindings<E extends object>(env: E): E {
  const hit = instrumented.get(env);
  if (hit) return hit as E;
  const src = env as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  for (const [name, kind] of Object.entries(DO_KIND)) {
    if (src[name] && typeof src[name] === 'object')
      out[name] = wrapNamespace(src[name] as object, kind);
  }
  if (src.PLATFORM_DB && typeof src.PLATFORM_DB === 'object')
    out.PLATFORM_DB = wrapD1(src.PLATFORM_DB as object);
  if (src.ACCOUNTS && typeof src.ACCOUNTS === 'object')
    out.ACCOUNTS = wrapCalls(src.ACCOUNTS as object, 'accounts');
  if (src.KV_CACHE && typeof src.KV_CACHE === 'object')
    out.KV_CACHE = wrapCalls(src.KV_CACHE as object, 'kv');
  instrumented.set(env, out);
  instrumented.set(out, out);
  return out as E;
}

/**
 * `Server-Timing` entries for the tally: `<kind>;desc="<calls>";dur=<summed ms>` for each kind that was called, then
 * `io-waves;desc="<serial round trips>"`.
 */
export function formatIoTiming(t: IoTally): string[] {
  const out = IO_KINDS.filter(k => t.n[k] > 0).map(
    k => `${k};desc="${t.n[k]}";dur=${t.ms[k].toFixed(1)}`
  );
  if (t.waves > 0) out.push(`io-waves;desc="${t.waves}"`);
  return out;
}
