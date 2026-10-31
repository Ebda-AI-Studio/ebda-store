/**
 * An in-memory stand-in for a store's Durable Object, for unit tests of jobs that run on the DO path (Ruling CF-JOBS-4).
 * It speaks the same Prisma-shaped surface as `storeDb` (reads) and `storeWriter` (writes) and keeps its rows in plain arrays,
 * so a test can assert what a job read, what it wrote and that a second delivery left the same state. It understands the
 * filters the jobs use (equality, in / notIn / not, lt / lte / gt / gte, OR / AND, nested relation equality is NOT supported).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = Record<string, any>;

function cmp(v: unknown, f: unknown): boolean {
  if (f !== null && typeof f === 'object' && !(f instanceof Date) && !Array.isArray(f)) {
    const o = f as Record<string, unknown>;
    const t = (x: unknown) => (x instanceof Date ? x.getTime() : x);
    if ('in' in o && !(o.in as unknown[]).map(t).includes(t(v))) return false;
    if ('notIn' in o && (o.notIn as unknown[]).map(t).includes(t(v))) return false;
    if ('not' in o && t(v) === t(o.not)) return false;
    if ('lt' in o && !((t(v) as number) < (t(o.lt) as number))) return false;
    if ('lte' in o && !((t(v) as number) <= (t(o.lte) as number))) return false;
    if ('gt' in o && !((t(v) as number) > (t(o.gt) as number))) return false;
    if ('gte' in o && !((t(v) as number) >= (t(o.gte) as number))) return false;
    if ('equals' in o && t(v) !== t(o.equals)) return false;
    return true;
  }
  return (f instanceof Date ? f.getTime() : f) === (v instanceof Date ? v.getTime() : v);
}
export function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([k, f]) => {
    if (k === 'OR') return (f as Where[]).some(w => matches(row, w));
    if (k === 'AND') return (f as Where[]).every(w => matches(row, w));
    // a compound unique selector (`storeId_feature: { storeId, feature }`) is the same equality on its parts
    if (
      !(k in row) &&
      k.includes('_') &&
      f !== null &&
      typeof f === 'object' &&
      !(f instanceof Date)
    )
      return matches(row, f as Where);
    if (f === undefined) return true;
    return cmp(row[k], f);
  });
}

let seq = 0;
export class FakeStoreDo {
  tables = new Map<string, Row[]>();
  /** every write call, in order: `model.op` */
  writes: string[] = [];
  /** every read call, in order: `model.op` */
  reads: string[] = [];
  /** column defaults the real schema applies on insert (`@default(now())`), by model */
  defaults: Record<string, () => Row> = {
    profitAnomaly: () => ({ detectedAt: new Date() }),
    answerEngineCheck: () => ({ runAt: new Date() }),
    bulkAiJob: () => ({ createdAt: new Date() }),
  };
  procs: Array<{ name: string; args: unknown }> = [];
  procResult: (name: string, args: unknown) => unknown = () => ({});

  rows(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }
  seed(model: string, ...rows: Row[]): this {
    this.rows(model).push(...rows);
    return this;
  }

  private pick(r: Row, select?: Row): Row {
    if (!select) return { ...r };
    return Object.fromEntries(
      Object.entries(select)
        .filter(([, v]) => v)
        .map(([k]) => [k, r[k]])
    );
  }

  private delegate(model: string, writable: boolean) {
    const t = () => this.rows(model);
    const read = (op: string) => this.reads.push(`${model}.${op}`);
    const write = (op: string) => this.writes.push(`${model}.${op}`);
    const d: Record<string, (a?: Row) => Promise<unknown>> = {
      findMany: async a => {
        read('findMany');
        let rows = t().filter(r => matches(r, a?.where));
        if (a?.take !== undefined) rows = rows.slice(0, a.take);
        return rows.map(r => this.pick(r, a?.select));
      },
      findFirst: async a => {
        read('findFirst');
        const r = t().find(x => matches(x, a?.where));
        return r ? this.pick(r, a?.select) : null;
      },
      findUnique: async a => {
        read('findUnique');
        const r = t().find(x => matches(x, a?.where));
        return r ? this.pick(r, a?.select) : null;
      },
      count: async a => {
        read('count');
        return t().filter(r => matches(r, a?.where)).length;
      },
      groupBy: async a => {
        read('groupBy');
        const by = (a?.by as string[]) ?? [];
        const groups = new Map<string, Row[]>();
        for (const r of t().filter(x => matches(x, a?.where))) {
          const k = JSON.stringify(by.map(b => r[b]));
          groups.set(k, [...(groups.get(k) ?? []), r]);
        }
        return [...groups.values()].map(rs => ({
          ...Object.fromEntries(by.map(b => [b, rs[0][b]])),
          _count: { _all: rs.length },
        }));
      },
      aggregate: async a => {
        read('aggregate');
        const rows = t().filter(r => matches(r, a?.where));
        const sum = Object.fromEntries(
          Object.keys((a?._sum as Row) ?? {}).map(k => [
            k,
            rows.reduce((n, r) => n + Number(r[k] ?? 0), 0),
          ])
        );
        return { _count: { id: rows.length, _all: rows.length }, _sum: sum };
      },
    };
    if (!writable) return d;
    return {
      ...d,
      create: async (a?: Row) => {
        write('create');
        const row = { id: `${model}-${++seq}`, ...(this.defaults[model]?.() ?? {}), ...a!.data };
        t().push(row);
        return { ...row };
      },
      createMany: async (a?: Row) => {
        write('createMany');
        let n = 0;
        for (const data of a!.data as Row[]) {
          const dup =
            a!.skipDuplicates && t().some(r => Object.entries(data).every(([k, v]) => r[k] === v));
          if (dup) continue;
          t().push({ id: `${model}-${++seq}`, ...data });
          n++;
        }
        return { count: n };
      },
      update: async (a?: Row) => {
        write('update');
        const r = t().find(x => matches(x, a!.where));
        if (!r) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        Object.assign(r, a!.data);
        return { ...r };
      },
      updateMany: async (a?: Row) => {
        write('updateMany');
        const rs = t().filter(x => matches(x, a!.where));
        for (const r of rs) Object.assign(r, a!.data);
        return { count: rs.length };
      },
      upsert: async (a?: Row) => {
        write('upsert');
        const r = t().find(x => matches(x, a!.where));
        if (r) return Object.assign(r, a!.update);
        const row = { id: `${model}-${++seq}`, ...a!.create };
        t().push(row);
        return row;
      },
      deleteMany: async (a?: Row) => {
        write('deleteMany');
        const keep = t().filter(r => !matches(r, a?.where));
        const n = t().length - keep.length;
        this.tables.set(model, keep);
        return { count: n };
      },
      delete: async (a?: Row) => {
        write('delete');
        const keep = t().filter(r => !matches(r, a!.where));
        this.tables.set(model, keep);
        return {};
      },
    };
  }

  private client(writable: boolean) {
    const cache = new Map<string, unknown>();
    const base: Record<string | symbol, unknown> = {
      $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
      $proc: async (name: string, args: unknown) => {
        this.procs.push({ name, args });
        return this.procResult(name, args);
      },
    };
    return new Proxy(base, {
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop in target) return target[prop as string];
        if (!cache.has(prop)) cache.set(prop, this.delegate(prop, writable));
        return cache.get(prop);
      },
    }) as never;
  }
  /** the read client (`storeDb`) */
  db = this.client(false);
  /** the write client (`storeWriter`): reads too, like the real one */
  writer = this.client(true);
}

/** A `prisma` stand-in that throws for any model that lives in the store's DO: "Postgres touched: prisma.<model>". */
export function postgresGuard(platform: Record<string, unknown> = {}): never {
  return new Proxy(platform, {
    get: (t, p) => {
      if (typeof p === 'symbol' || p in t) return (t as Record<string, unknown>)[p as string];
      if (p === 'then') return undefined;
      throw new Error(`Postgres touched: prisma.${String(p)}`);
    },
  }) as never;
}
