/**
 * A Prisma-shaped client over Cloudflare D1 (NEON-ZERO-1). D1 is asynchronous; the prisma-lite engine is synchronous.
 * Rather than fork 1,700 lines of query compilation, every operation runs the SAME engine against a JOURNAL runner:
 *
 *   run the operation; when the engine asks for a statement the journal does not hold yet, the runner throws a private
 *   sentinel; the loop executes exactly that statement on D1, appends its result (or its error) to the journal and runs
 *   the operation again from the start, serving every earlier statement from the journal by position.
 *
 * Properties this relies on, and why they hold:
 *   - the engine is deterministic given statement results (no I/O besides the runner); the two non-deterministic inputs
 *     it has, generated ids and `now`, are pinned per operation through `withEntropy` and extended in order;
 *   - each statement reaches D1 exactly once (a replay never re-executes), so a write is never applied twice;
 *   - reads cost O(k^2) CPU for k sequential statements (k is single digits: pk lookup, include fan-out).
 *
 * NOT ATOMIC ACROSS STATEMENTS. D1 has no interactive transaction. A single-statement write (`updateMany`, `deleteMany`,
 * `createMany` of one row, `create` without nesting) is as atomic as D1 makes one statement; an `update` / `upsert` /
 * nested write is several statements and a failure midway leaves the earlier ones applied. `$transaction` is therefore
 * REFUSED (it would silently promise atomicity it cannot give); a caller that needs it must be one statement or use
 * `d1.batch` itself. Every refusal is loud: `D1_NO_TRANSACTION`.
 */
import { createPrismaLite } from './client';
import { withEntropy, type Entropy } from './entropy';
import type { Meta, SqlRunner } from './types';

/** A D1 session (Sessions API): same prepare surface plus the bookmark of the last read / write it served. */
export interface D1SessionLike {
  prepare: D1Like['prepare'];
  getBookmark?(): string | null;
}

/** The slice of a D1 database this client uses. */
export interface D1Like {
  /** Sessions API (read replication). Absent on a database without it; replica reads then fall back to the primary. */
  withSession?(constraint?: string): D1SessionLike;
  /** Atomic batch of independent statements, one round trip. */
  batch?(stmts: unknown[]): Promise<unknown[]>;
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[]; meta?: { changes?: number } }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

class Need extends Error {
  constructor(
    readonly kind: 'all' | 'run',
    readonly sql: string,
    readonly params: unknown[]
  ) {
    super('prisma-lite d1: statement not journaled yet');
  }
}

type Entry =
  | { ok: true; rows: Record<string, unknown>[]; changes: number }
  | { ok: false; error: unknown };

const bindable = (v: unknown): unknown =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Max statements one operation may issue: a runaway replay loop is a bug, not a retry. */
const MAX_STATEMENTS = 64;

export interface D1ClientOptions {
  /**
   * Replica-safe reads (rule 6 of NEON-SCALE-1): SELECTs go through `d1.withSession(bookmark ?? 'first-unconstrained')`
   * and may be served by a read replica; every write, and every statement of an operation that writes, stays on the
   * primary. Never set it for auth, billing state or the directory miss path.
   */
  replicaReads?: boolean;
  /** Bookmark from a previous response (`x-d1-bookmark`) so a client never reads older data than it saw. */
  bookmark?: string;
  /** Called once per statement that really reaches D1 (call-count tests, per-request budget counters). */
  onStatement?: (e: { kind: 'all' | 'run' | 'batch'; sql: string; replica: boolean }) => void;
}

export function createD1Client(meta: Meta, d1: D1Like, opts: D1ClientOptions = {}) {
  let session: D1SessionLike | undefined;
  /** The bookmark to hand back to the caller after replica reads (null when none was used). */
  const bookmark = (): string | null => session?.getBookmark?.() ?? null;

  async function execute(n: Need, writing: boolean): Promise<Entry> {
    try {
      const replica = !!opts.replicaReads && !writing && n.kind === 'all' && !!d1.withSession;
      opts.onStatement?.({ kind: n.kind, sql: n.sql, replica });
      const target: D1SessionLike = replica
        ? (session ??= d1.withSession!(opts.bookmark ?? 'first-unconstrained'))
        : d1;
      const stmt = target.prepare(n.sql).bind(...n.params.map(bindable));
      if (n.kind === 'all') {
        const r = await stmt.all();
        return { ok: true, rows: r.results ?? [], changes: 0 };
      }
      const r = await stmt.run();
      return { ok: true, rows: [], changes: Number(r.meta?.changes ?? 0) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Run one delegate call to completion against a fresh journal. */
  async function journaled<T>(call: (client: any) => PromiseLike<T>, writes: boolean): Promise<T> {
    const journal: Entry[] = [];
    const uuids: string[] = [];
    let nowMs: number | undefined;
    for (;;) {
      let pos = 0;
      let uu = 0;
      const entropy: Entropy = {
        uuid: () => {
          uuids[uu] ??= crypto.randomUUID();
          return uuids[uu++];
        },
        now: () => new Date((nowMs ??= Date.now())),
      };
      const serve = (kind: 'all' | 'run', sql: string, params: unknown[]): Entry => {
        const e = journal[pos];
        if (!e) throw new Need(kind, sql, params);
        pos++;
        return e;
      };
      const runner: SqlRunner = {
        all(sql, params) {
          const e = serve('all', sql, params);
          if (!e.ok) throw e.error;
          return e.rows;
        },
        run(sql, params) {
          const e = serve('run', sql, params);
          if (!e.ok) throw e.error;
          return { changes: e.changes };
        },
        // `atomic()` in client.ts calls this; the body runs synchronously so the entropy scope covers it. No atomicity.
        transaction: async fn => withEntropy(entropy, () => fn()) as never,
      };
      const client = createPrismaLite(meta, runner, 'd1', { unscoped: true });
      try {
        return await call(client);
      } catch (e) {
        if (!(e instanceof Need)) throw e;
        if (journal.length >= MAX_STATEMENTS)
          throw new Error(`prisma-lite d1: operation exceeded ${MAX_STATEMENTS} statements`);
        journal.push(await execute(e, writes));
      }
    }
  }

  /** Lazy like Prisma's PrismaPromise: nothing runs until awaited (the first then/catch/finally starts it, once). */
  const lazyCall = <T>(start: () => Promise<T>): PromiseLike<T> & Promise<T> => {
    let p: Promise<T> | undefined;
    const run = () => (p ??= start());
    return {
      then: (ok: any, err: any) => run().then(ok, err),
      catch: (err: any) => run().catch(err),
      finally: (f: any) => run().finally(f),
      [Symbol.toStringTag]: 'D1Query',
    } as never;
  };

  const refusal = () =>
    Object.assign(
      new Error(
        'D1_NO_TRANSACTION: D1 has no interactive transaction; make the write a single statement or use d1.batch'
      ),
      { code: 'D1_NO_TRANSACTION' }
    );

  const models = new Set(
    Object.entries(meta.models)
      .filter(([, m]) => m.db === 'd1')
      .map(([n]) => n[0].toLowerCase() + n.slice(1))
  );

  return new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop === '$transaction') return () => Promise.reject(refusal());
        if (prop === '$bookmark') return bookmark;
        if (prop === '$batch')
          return async (stmts: Array<{ sql: string; params?: unknown[] }>) => {
            if (!d1.batch) throw new Error('prisma-lite d1: this D1 binding has no batch()');
            for (const st of stmts)
              opts.onStatement?.({ kind: 'batch', sql: st.sql, replica: false });
            return d1.batch(
              stmts.map(st => d1.prepare(st.sql).bind(...(st.params ?? []).map(bindable)))
            );
          };
        if (prop === '$connect' || prop === '$disconnect') return async () => undefined;
        if (!models.has(prop)) throw new Error(`prisma-lite d1: no model delegate "${prop}" in D1`);
        return new Proxy(
          {},
          {
            get(_d, op: string | symbol) {
              if (typeof op === 'symbol' || op === 'then') return undefined;
              const writes = WRITE_OPS.has(op);
              return (args?: unknown) =>
                lazyCall(() =>
                  journaled(
                    c => (c[prop][op] as (a?: unknown) => PromiseLike<unknown>)(args),
                    writes
                  )
                );
            },
          }
        );
      },
    }
  ) as Record<string, any>;
}
