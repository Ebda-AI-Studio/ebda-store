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

/** The slice of a D1 database this client uses. */
export interface D1Like {
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

/** Max statements one operation may issue: a runaway replay loop is a bug, not a retry. */
const MAX_STATEMENTS = 64;

export function createD1Client(meta: Meta, d1: D1Like) {
  async function execute(n: Need): Promise<Entry> {
    try {
      const stmt = d1.prepare(n.sql).bind(...n.params.map(bindable));
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
  async function journaled<T>(call: (client: any) => PromiseLike<T>): Promise<T> {
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
        journal.push(await execute(e));
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
        if (prop === '$connect' || prop === '$disconnect') return async () => undefined;
        if (!models.has(prop)) throw new Error(`prisma-lite d1: no model delegate "${prop}" in D1`);
        return new Proxy(
          {},
          {
            get(_d, op: string | symbol) {
              if (typeof op === 'symbol' || op === 'then') return undefined;
              return (args?: unknown) =>
                lazyCall(() =>
                  journaled(c => (c[prop][op] as (a?: unknown) => PromiseLike<unknown>)(args))
                );
            },
          }
        );
      },
    }
  ) as Record<string, any>;
}
