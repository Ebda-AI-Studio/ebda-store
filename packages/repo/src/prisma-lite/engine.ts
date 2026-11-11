import { Prisma } from '@prisma/client';
import type { FieldMeta, Meta, ModelMeta, RelationField, ScalarField, SqlRunner } from './types';
import { decode, encode } from './codec';
import { enumRankSql } from './enum-order';

/** Cloudflare DO SQLite allows 100 bound parameters per statement. Asserted for EVERY statement (see `guarded`). */
export const MAX_BOUND = 100;
/** Parameter budget for key chunks (leaves room for the child `where`). */
export const MAX_PARAMS = 90;
const MAX_WHERE_DEPTH = 32;
const MAX_INCLUDE_DEPTH = 5;
const MAX_HYDRATED_ROWS = 20_000;

type Where = Record<string, unknown> | undefined;
type Args = Record<string, any>;

const q = (s: string) => {
  // Identifiers come from the schema registry only; refuse anything that is not a plain identifier anyway.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    throw new Error(`prisma-lite: refusing identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
};

/** ASC/DESC only, case-insensitive. Anything else throws before any SQL is built. */
export function sortDir(v: unknown): 'ASC' | 'DESC' {
  const d = typeof v === 'string' ? v.toLowerCase() : '';
  if (d === 'asc') return 'ASC';
  if (d === 'desc') return 'DESC';
  throw new Error('prisma-lite: sort direction must be asc or desc');
}
export function nullsPos(v: unknown): 'FIRST' | 'LAST' {
  const d = typeof v === 'string' ? v.toLowerCase() : '';
  if (d === 'first') return 'FIRST';
  if (d === 'last') return 'LAST';
  throw new Error('prisma-lite: nulls must be first or last');
}
function intArg(name: string, v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min)
    throw new Error(`prisma-lite: ${name} must be an integer >= ${min}`);
  return v;
}
export const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** The runner every statement goes through: refuses more than 100 bound parameters (the DO limit) in one place. */
function guarded(sql: SqlRunner): SqlRunner {
  const check = (p: unknown[]) => {
    if (p.length > MAX_BOUND)
      throw new Error(
        `prisma-lite: ${p.length} bound parameters exceed the Durable Object limit of ${MAX_BOUND}`
      );
  };
  return {
    all: (s, p) => (check(p), sql.all(s, p)),
    run: (s, p) => (check(p), sql.run(s, p)),
    ...(sql.transaction ? { transaction: sql.transaction.bind(sql) } : {}),
  };
}

const FIND_ARGS = new Set([
  'where',
  'select',
  'include',
  'omit',
  'orderBy',
  'take',
  'skip',
  'cursor',
  'distinct',
]);
const NESTED_ARGS = new Set(['where', 'select', 'include', 'omit', 'orderBy', 'take', 'skip']);

export class Engine {
  private alias = 0;
  readonly sql: SqlRunner;
  private hydrated = 0;
  constructor(
    readonly meta: Meta,
    sql: SqlRunner
  ) {
    this.sql = guarded(sql);
  }

  model(name: string): ModelMeta {
    const m = own(this.meta.models, name) ? this.meta.models[name] : undefined;
    if (!m) throw new Error(`prisma-lite: model ${name} is not in this database`);
    return m;
  }

  private nextAlias(): string {
    return `t${++this.alias}`;
  }

  scalar(m: ModelMeta, name: string): ScalarField {
    const f = own(m.fields, name) ? m.fields[name] : undefined;
    if (!f || f.kind === 'relation') throw new Error(`prisma-lite: ${name} is not a scalar field`);
    return f;
  }

  // ---------------------------------------------------------------- where
  compileWhere(
    modelName: string,
    where: Where,
    alias: string,
    params: unknown[],
    depth = 0
  ): string {
    const m = this.model(modelName);
    if (where === undefined || where === null) return '1';
    if (!isPlain(where)) throw new Error('prisma-lite: where must be a plain object');
    if (depth > MAX_WHERE_DEPTH) throw new Error('prisma-lite: where is nested too deeply');
    const parts: string[] = [];
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined) continue;
      if (key === 'AND' || key === 'OR') {
        const list = (Array.isArray(val) ? val : [val]) as Where[];
        const sub = list.map(w => this.compileWhere(modelName, w, alias, params, depth + 1));
        if (sub.length === 0) parts.push(key === 'AND' ? '1' : '0');
        else parts.push(`(${sub.join(key === 'AND' ? ' AND ' : ' OR ')})`);
        continue;
      }
      if (key === 'NOT') {
        const list = (Array.isArray(val) ? val : [val]) as Where[];
        for (const w of list)
          parts.push(`NOT (${this.compileWhere(modelName, w, alias, params, depth + 1)})`);
        continue;
      }
      if (!own(m.fields, key))
        throw new Error(`prisma-lite: unknown field ${modelName}.${key} in where`);
      const f = m.fields[key];
      if (f.kind === 'relation') {
        parts.push(
          this.compileRelationFilter(
            m,
            key,
            f,
            val as Record<string, unknown>,
            alias,
            params,
            depth + 1
          )
        );
      } else {
        parts.push(this.compileScalarFilter(f, `${alias}.${q(f.column)}`, val, params));
      }
    }
    return parts.length ? parts.join(' AND ') : '1';
  }

  /**
   * A Json path filter `{ path: ['phone'], equals: '+20…' }` (promotion-resolver's first-order check). Prisma on Postgres
   * compares the JSON VALUE at the path: a string matches only a JSON string, a number only a JSON number. `equals` with a
   * string or a finite number is the only form supported; keys are plain identifiers and the JSON path is a bound parameter.
   */
  private compileJsonPath(
    f: ScalarField,
    col: string,
    ops: Record<string, unknown>,
    params: unknown[]
  ): string {
    if (f.type !== 'Json' || f.list) throw new Error('prisma-lite: `path` is a Json filter');
    const path = ops.path;
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.length > 8 ||
      path.some(k => typeof k !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(k))
    )
      throw new Error('prisma-lite: a Json path is 1-8 plain keys');
    const rest = Object.keys(ops).filter(k => k !== 'path' && ops[k] !== undefined);
    if (rest.length !== 1 || rest[0] !== 'equals')
      throw new Error('prisma-lite: a Json path filter supports `equals` only');
    const v = ops.equals;
    const jp = `$.${(path as string[]).join('.')}`;
    if (typeof v === 'string') {
      params.push(jp, jp, v);
      return `(json_type(${col}, ?) = 'text' AND json_extract(${col}, ?) = ?)`;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      params.push(jp, jp, v);
      return `(json_type(${col}, ?) IN ('integer', 'real') AND json_extract(${col}, ?) = ?)`;
    }
    throw new Error('prisma-lite: a Json path `equals` takes a string or a number');
  }

  private compileScalarFilter(
    f: ScalarField,
    col: string,
    val: unknown,
    params: unknown[],
    optionalNot = true
  ): string {
    if (val === null || val === Prisma.DbNull) return `${col} IS NULL`;
    if (val === Prisma.JsonNull) return `${col} = 'null'`;
    if (val === Prisma.AnyNull) return `(${col} IS NULL OR ${col} = 'null')`;
    if (!isPlain(val)) {
      if (f.type === 'Json' && !f.list && typeof val === 'object' && !(val instanceof Date))
        throw new Error(
          'prisma-lite: Json equality on an object/array is not supported (key order would change the answer)'
        );
      params.push(encode(f, val, true));
      return `${col} = ?`;
    }
    const ops = val as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(ops, 'path'))
      return this.compileJsonPath(f, col, ops, params);
    const insensitive = ops.mode === 'insensitive';
    const out: string[] = [];
    const lc = (s: string) => (insensitive ? `lower(${s})` : s);
    const bind = (v: unknown) => {
      params.push(insensitive && typeof v === 'string' ? v.toLowerCase() : encode(f, v, true));
      return '?';
    };
    for (const [op, v] of Object.entries(ops)) {
      if (v === undefined || op === 'mode') continue;
      switch (op) {
        case 'equals':
          if (v === null || v === Prisma.DbNull) out.push(`${col} IS NULL`);
          else {
            if (f.type === 'Json' && !f.list && typeof v === 'object')
              throw new Error('prisma-lite: Json equals on an object is not supported');
            out.push(`${lc(col)} = ${bind(v)}`);
          }
          break;
        case 'not':
          if (v === null) out.push(`${col} IS NOT NULL`);
          else if (isPlain(v)) {
            // Prisma emits plain SQL three-valued logic here: a NULL row does NOT match `not`/`notIn` (verified against Postgres in prisma-lite-reads.diff.test.ts)
            out.push(`NOT (${this.compileScalarFilter(f, col, { ...v, mode: ops.mode }, params)})`);
          } else out.push(`${lc(col)} <> ${bind(v)}`);
          break;
        case 'in': {
          const list = inList(v);
          if (list.length === 0) out.push('0');
          else {
            params.push(
              JSON.stringify(
                list.map(x =>
                  insensitive && typeof x === 'string' ? x.toLowerCase() : encode(f, x, true)
                )
              )
            );
            out.push(`${lc(col)} IN (SELECT value FROM json_each(?))`);
          }
          break;
        }
        case 'notIn': {
          const list = inList(v);
          if (list.length === 0) out.push('1');
          else {
            params.push(
              JSON.stringify(
                list.map(x =>
                  insensitive && typeof x === 'string' ? x.toLowerCase() : encode(f, x, true)
                )
              )
            );
            out.push(`${lc(col)} NOT IN (SELECT value FROM json_each(?))`);
          }
          break;
        }
        case 'lt':
          out.push(`${lc(col)} < ${bind(v)}`);
          break;
        case 'lte':
          out.push(`${lc(col)} <= ${bind(v)}`);
          break;
        case 'gt':
          out.push(`${lc(col)} > ${bind(v)}`);
          break;
        case 'gte':
          out.push(`${lc(col)} >= ${bind(v)}`);
          break;
        case 'contains':
        case 'startsWith':
        case 'endsWith': {
          if (typeof v !== 'string') throw new Error(`prisma-lite: ${op} needs a string`);
          const esc = v.replace(/[\\%_]/g, '\\$&');
          const pat = op === 'contains' ? `%${esc}%` : op === 'startsWith' ? `${esc}%` : `%${esc}`;
          params.push(pat);
          // SQLite LIKE folds ASCII case; Prisma without `mode` is case-sensitive, so add an exact-case check.
          if (insensitive || v === '') out.push(`${col} LIKE ? ESCAPE '\\'`);
          else out.push(`${col} LIKE ? ESCAPE '\\' AND ${caseSensitiveCheck(op, col, params, v)}`);
          break;
        }
        default:
          throw new Error(`prisma-lite: unsupported scalar filter ${op}`);
      }
    }
    void optionalNot;
    return out.length ? `(${out.join(' AND ')})` : '1';
  }

  private compileRelationFilter(
    m: ModelMeta,
    key: string,
    f: RelationField,
    val: Record<string, unknown> | null,
    alias: string,
    params: unknown[],
    depth: number
  ): string {
    if (f.external)
      throw new Error(
        `prisma-lite: ${m.table}.${key} points at another database and cannot be filtered`
      );
    const t = this.model(f.type);
    const a = this.nextAlias();
    const join = f.from!.map((c, i) => `${a}.${q(f.to![i])} = ${alias}.${q(c)}`).join(' AND ');
    const exists = (w: Where, negate = false) => {
      const cond = this.compileWhere(f.type, w, a, params, depth + 1);
      return `${negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${q(t.table)} ${a} WHERE ${join} AND ${cond})`;
    };
    if (val === null) {
      if (f.list) throw new Error('prisma-lite: a list relation cannot be filtered with null');
      return `NOT EXISTS (SELECT 1 FROM ${q(t.table)} ${a} WHERE ${join})`;
    }
    if (!isPlain(val))
      throw new Error(`prisma-lite: relation filter on ${key} must be a plain object`);
    const keys = Object.keys(val);
    if (f.list) {
      const parts: string[] = [];
      for (const k of keys) {
        if (k === 'some') parts.push(exists(val.some as Where));
        else if (k === 'none') parts.push(exists(val.none as Where, true));
        else if (k === 'every') parts.push(exists({ NOT: val.every as Where }, true));
        else
          throw new Error(
            `prisma-lite: unknown list relation filter ${JSON.stringify(k)} on ${key} (use some/none/every)`
          );
      }
      return parts.length ? parts.join(' AND ') : '1';
    }
    // to-one: { is, isNot } or the filter itself
    if (keys.length > 0 && keys.every(k => k === 'is' || k === 'isNot')) {
      const parts: string[] = [];
      if (own(val, 'is'))
        parts.push(val.is === null ? exists(undefined, true) : exists(val.is as Where));
      if (own(val, 'isNot'))
        parts.push(val.isNot === null ? exists(undefined) : exists(val.isNot as Where, true));
      return parts.join(' AND ');
    }
    return exists(val as Where);
  }

  // ------------------------------------------------------------- orderBy
  /**
   * `nulls` defaults to Postgres's: NULLS LAST for ASC, NULLS FIRST for DESC (SQLite's default is the opposite),
   * so a nullable column pages in the same order on both engines.
   */
  compileOrderBy(modelName: string, orderBy: unknown, alias: string, params: unknown[]): string {
    const m = this.model(modelName);
    const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<
      string,
      any
    >[];
    const out: string[] = [];
    for (const item of list) {
      if (!isPlain(item)) throw new Error('prisma-lite: orderBy entries must be plain objects');
      for (const [key, dir] of Object.entries(item)) {
        const f = own(m.fields, key) ? (m.fields[key] as FieldMeta) : undefined;
        if (key === '_count') {
          for (const [rel, d] of Object.entries(dir as Record<string, string>)) {
            const rf = this.listRelation(m, rel);
            out.push(`${this.countSubquery(rf, alias)} ${sortDir(d)}`);
          }
          continue;
        }
        if (!f) throw new Error(`prisma-lite: unknown orderBy field ${modelName}.${key}`);
        if (f.kind !== 'relation') {
          const dobj = (typeof dir === 'object' && dir !== null ? dir : {}) as {
            sort?: unknown;
            nulls?: unknown;
          };
          const d = sortDir(typeof dir === 'string' ? dir : dobj.sort);
          const nulls =
            dobj.nulls !== undefined ? nullsPos(dobj.nulls) : d === 'ASC' ? 'LAST' : 'FIRST';
          const col = `${alias}.${q(f.column)}`;
          out.push(
            `${f.kind === 'enum' && f.enum ? enumRankSql(col, f.enum, this.meta.enums) : col} ${d} NULLS ${nulls}`
          );
        } else if (!f.list && !f.external) {
          // to-one: order by the related row's column through a correlated subquery
          const t = this.model(f.type);
          const a = this.nextAlias();
          const join = f
            .from!.map((c, i) => `${a}.${q(f.to![i])} = ${alias}.${q(c)}`)
            .join(' AND ');
          const entries = Object.entries(dir as Record<string, string>);
          if (entries.length !== 1)
            throw new Error('prisma-lite: relation orderBy takes exactly one field');
          const [[col, d]] = entries;
          const cf = this.scalar(t, col);
          const dd = sortDir(d);
          const sub = `(SELECT ${a}.${q(cf.column)} FROM ${q(t.table)} ${a} WHERE ${join})`;
          out.push(
            `${cf.kind === 'enum' && cf.enum ? enumRankSql(sub, cf.enum, this.meta.enums) : sub} ${dd} NULLS ${dd === 'ASC' ? 'LAST' : 'FIRST'}`
          );
        } else if (
          f.list &&
          isPlain(dir) &&
          Object.keys(dir).length === 1 &&
          own(dir as object, '_count')
        ) {
          // Prisma's own shape for ordering by how many related rows there are: `{ products: { _count: 'desc' } }`
          out.push(
            `${this.countSubquery(this.listRelation(m, key), alias)} ${sortDir(dir._count)}`
          );
        } else throw new Error(`prisma-lite: unsupported orderBy on relation ${key}`);
      }
    }
    void params;
    return out.join(', ');
  }

  private listRelation(m: ModelMeta, rel: string): RelationField {
    const rf = own(m.fields, rel) ? m.fields[rel] : undefined;
    if (!rf || rf.kind !== 'relation' || !rf.list || rf.external || !rf.from)
      throw new Error(`prisma-lite: ${rel} is not a countable relation`);
    return rf;
  }

  private countSubquery(rf: RelationField, alias: string): string {
    const t = this.model(rf.type);
    const a = this.nextAlias();
    const join = rf.from!.map((c, i) => `${a}.${q(rf.to![i])} = ${alias}.${q(c)}`).join(' AND ');
    return `(SELECT count(*) FROM ${q(t.table)} ${a} WHERE ${join})`;
  }

  // --------------------------------------------------------------- reads
  private checkArgs(args: Args, allowed: Set<string>): void {
    for (const k of Object.keys(args))
      if (!allowed.has(k))
        throw new Error(`prisma-lite: unsupported argument ${JSON.stringify(k)}`);
  }

  /** Cursor: the page starts AT the cursor row (inclusive, like Prisma) in the full ORDER BY + primary-key order. */
  private cursorCondition(
    modelName: string,
    m: ModelMeta,
    cursor: unknown,
    orderBy: unknown,
    alias: string,
    params: unknown[]
  ): string {
    if (!isPlain(cursor) || Object.keys(cursor).length === 0)
      throw new Error('prisma-lite: cursor must name a unique field');
    const crow = this.findMany(modelName, { where: cursorWhere(m, cursor), take: 1 })[0];
    if (!crow) return '0'; // Prisma returns an empty page for a cursor that matches no row
    const keys: { f: ScalarField; prop: string; desc: boolean }[] = [];
    const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<
      string,
      any
    >[];
    for (const item of list)
      for (const [k, d] of Object.entries(item)) {
        if (k === '_count')
          throw new Error('prisma-lite: cursor with orderBy _count is not supported');
        const f = own(m.fields, k) ? m.fields[k] : undefined;
        if (!f || f.kind === 'relation')
          throw new Error('prisma-lite: cursor with orderBy on a relation is not supported');
        if (f.kind === 'enum')
          throw new Error('prisma-lite: cursor with orderBy on an enum is not supported');
        keys.push({ f, prop: k, desc: sortDir(typeof d === 'string' ? d : d?.sort) === 'DESC' });
      }
    for (const p of m.pk)
      if (!keys.some(k => k.prop === p)) keys.push({ f: this.scalar(m, p), prop: p, desc: false });
    const enc = (k: { f: ScalarField; prop: string }) => {
      const v = crow[k.prop];
      if (v === null || v === undefined)
        throw new Error('prisma-lite: cursor row has NULL in a sort key; not supported');
      return encode(k.f, v);
    };
    const ors: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const eq = keys.slice(0, i).map(k => (params.push(enc(k)), `${alias}.${q(k.f.column)} = ?`));
      params.push(enc(keys[i]));
      ors.push(
        `(${[...eq, `${alias}.${q(keys[i].f.column)} ${keys[i].desc ? '<' : '>'} ?`].join(' AND ')})`
      );
    }
    // the cursor row itself
    const self = keys.map(k => (params.push(enc(k)), `${alias}.${q(k.f.column)} = ?`));
    ors.push(`(${self.join(' AND ')})`);
    return `(${ors.join(' OR ')})`;
  }

  /** Run a find; returns decoded rows with select/include relations attached. */
  findMany(modelName: string, args: Args = {}, depth = 0): Record<string, unknown>[] {
    if (depth === 0) this.hydrated = 0;
    this.checkArgs(args, FIND_ARGS);
    const m = this.model(modelName);
    const params: unknown[] = [];
    const a = 't0';
    if (args.distinct !== undefined) throw new Error('prisma-lite: distinct is not supported');
    let where = this.compileWhere(modelName, args.where, a, params);
    const take = args.take === undefined ? undefined : intArg('take', args.take);
    const skip = args.skip === undefined ? 0 : intArg('skip', args.skip);
    if (args.cursor !== undefined)
      where += ` AND ${this.cursorCondition(modelName, m, args.cursor, args.orderBy, a, params)}`;
    let order = this.compileOrderBy(modelName, args.orderBy, a, params);
    // Stable order for paging when the caller gave none.
    if (!order && (take !== undefined || skip || args.cursor !== undefined))
      order = m.pk.map(p => `${a}.${q(this.scalar(m, p).column)}`).join(', ');
    else if (order && (take !== undefined || skip))
      order += `, ${m.pk.map(p => `${a}.${q(this.scalar(m, p).column)}`).join(', ')}`;
    let sql = `SELECT ${a}.* FROM ${q(m.table)} ${a} WHERE ${where}`;
    if (order) sql += ` ORDER BY ${order}`;
    if (take !== undefined || skip) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(take ?? -1, skip);
    }
    const rows = this.sql.all(sql, params);
    return this.hydrate(modelName, rows, args, depth);
  }

  count(modelName: string, args: Args = {}): number {
    const m = this.model(modelName);
    const params: unknown[] = [];
    const where = this.compileWhere(modelName, args.where, 't0', params);
    let sql = `SELECT count(*) AS n FROM ${q(m.table)} t0 WHERE ${where}`;
    if (args.take !== undefined || args.skip !== undefined) {
      const take = args.take === undefined ? -1 : intArg('take', args.take);
      const skip = args.skip === undefined ? 0 : intArg('skip', args.skip);
      sql = `SELECT count(*) AS n FROM (SELECT 1 FROM ${q(m.table)} t0 WHERE ${where} LIMIT ? OFFSET ?)`;
      params.push(take, skip);
    }
    return Number(this.sql.all(sql, params)[0].n);
  }

  /** Scalars returned when the query has no `select`: all of them minus the global `omit` and the query's `omit`. */
  private visibleScalars(modelName: string, m: ModelMeta, args: Args): string[] {
    const select = args.select as Record<string, any> | undefined;
    const scalarKeys = Object.keys(m.fields).filter(k => m.fields[k].kind !== 'relation');
    if (select) return scalarKeys.filter(k => select[k] === true);
    const omit = new Set<string>(
      own(this.meta.omit ?? {}, modelName) ? (this.meta.omit![modelName] ?? []) : []
    );
    const qo = args.omit as Record<string, boolean> | undefined;
    if (qo) {
      if (!isPlain(qo)) throw new Error('prisma-lite: omit must be a plain object');
      for (const [k, v] of Object.entries(qo)) {
        if (!own(m.fields, k) || m.fields[k].kind === 'relation')
          throw new Error(`prisma-lite: omit names unknown field ${modelName}.${k}`);
        if (v === true) omit.add(k);
        else if (v === false) omit.delete(k);
      }
    }
    return scalarKeys.filter(k => !omit.has(k));
  }

  private hydrate(
    modelName: string,
    rows: Record<string, unknown>[],
    args: Args,
    depth: number
  ): Record<string, unknown>[] {
    const m = this.model(modelName);
    if (depth > MAX_INCLUDE_DEPTH)
      throw new Error(`prisma-lite: include is nested deeper than ${MAX_INCLUDE_DEPTH}`);
    this.hydrated += rows.length;
    if (this.hydrated > MAX_HYDRATED_ROWS)
      throw new Error(`prisma-lite: a single query hydrated more than ${MAX_HYDRATED_ROWS} rows`);
    const select = args.select as Record<string, any> | undefined;
    const include = args.include as Record<string, any> | undefined;
    if (select && include) throw new Error('prisma-lite: select and include cannot be combined');
    const wanted = this.visibleScalars(modelName, m, args);
    const out = rows.map(r => {
      const o: Record<string, unknown> = {};
      for (const k of wanted)
        o[k] = decode(m.fields[k] as ScalarField, r[(m.fields[k] as ScalarField).column]);
      return o;
    });
    const relArgs: Record<string, any> = { ...(include ?? {}), ...(select ?? {}) };
    for (const [key, spec] of Object.entries(relArgs)) {
      if (!spec) continue;
      if (key === '_count') {
        this.attachCounts(modelName, rows, out, spec);
        continue;
      }
      if (!own(m.fields, key)) continue;
      const f = m.fields[key];
      if (f.kind !== 'relation') continue;
      if (f.external) throw new Error(`prisma-lite: ${modelName}.${key} lives in another database`);
      this.attachRelation(f, key, rows, out, spec === true ? {} : spec, depth + 1);
    }
    return out;
  }

  private attachCounts(
    modelName: string,
    rows: Record<string, unknown>[],
    out: Record<string, unknown>[],
    spec: any
  ): void {
    const m = this.model(modelName);
    const sel: Record<string, any> = spec === true ? {} : (spec.select ?? {});
    const rels =
      spec === true
        ? Object.keys(m.fields).filter(
            k =>
              m.fields[k].kind === 'relation' &&
              (m.fields[k] as RelationField).list &&
              !(m.fields[k] as RelationField).external
          )
        : Object.keys(sel).filter(k => sel[k]);
    for (const rel of rels) {
      const f = this.listRelation(m, rel);
      const t = this.model(f.type);
      const cw = isPlain(sel[rel]) ? (sel[rel] as Args).where : undefined;
      const fromCols = f.from!;
      const toCols = f.to!;
      const keys = uniqueKeys(rows, fromCols);
      const counts = new Map<string, number>();
      const keyExpr =
        toCols.length === 1
          ? `t0.${q(toCols[0])}`
          : `json_array(${toCols.map(c => `t0.${q(c)}`).join(', ')})`;
      for (const chunk of chunkKeys(keys, toCols.length, () => {
        const p: unknown[] = [];
        this.compileWhere(f.type, cw, 't0', p);
        return p.length;
      })) {
        const params: unknown[] = [];
        const w = this.compileWhere(f.type, cw, 't0', params);
        const cond = keyCondition(toCols, chunk, 't0', [], true);
        const full: unknown[] = [...cond.params, ...params];
        const sql = `SELECT ${keyExpr} AS k, count(*) AS n FROM ${q(t.table)} t0 WHERE ${cond.sql} AND ${w} GROUP BY ${keyExpr}`;
        for (const r of this.sql.all(sql, full))
          counts.set(toCols.length === 1 ? keyOf([r.k]) : String(r.k), Number(r.n));
      }
      rows.forEach((r, i) => {
        const c = (out[i]._count ??= {}) as Record<string, number>;
        c[rel] = counts.get(keyOf(fromCols.map(col => r[col]))) ?? 0;
      });
    }
  }

  private attachRelation(
    f: RelationField,
    key: string,
    rows: Record<string, unknown>[],
    out: Record<string, unknown>[],
    spec: Args,
    depth: number
  ): void {
    this.checkArgs(spec, NESTED_ARGS);
    const t = this.model(f.type);
    const fromCols = f.from!;
    const toCols = f.to!;
    const take = spec.take === undefined ? undefined : intArg('take', spec.take);
    const skip = spec.skip === undefined ? 0 : intArg('skip', spec.skip);
    const childArgs: Args = {
      where: spec.where,
      orderBy: spec.orderBy,
      select: spec.select,
      include: spec.include,
      omit: spec.omit,
    };
    const rawChildren: Record<string, unknown>[] = [];
    const pkOrder = t.pk.map(p => `t0.${q(this.scalar(t, p).column)}`);
    const windowed = f.list && (take !== undefined || skip > 0);
    for (const chunk of chunkKeys(uniqueKeys(rows, fromCols), toCols.length, () => {
      const p: unknown[] = [];
      this.compileWhere(f.type, spec.where, 't0', p);
      this.compileOrderBy(f.type, spec.orderBy, 't0', p);
      return p.length + (windowed ? 2 : 0);
    })) {
      const params: unknown[] = [];
      const cond = keyCondition(toCols, chunk, 't0', params, false);
      const w = this.compileWhere(f.type, spec.where, 't0', params);
      const order = this.compileOrderBy(f.type, spec.orderBy, 't0', params);
      const orderSql = [order, ...pkOrder].filter(Boolean).join(', ');
      let sql: string;
      if (windowed) {
        // per-parent take/skip in SQL: never load every child of every parent
        const part = toCols.map(c => `t0.${q(c)}`).join(', ');
        sql = `SELECT * FROM (SELECT t0.*, ROW_NUMBER() OVER (PARTITION BY ${part} ORDER BY ${orderSql}) AS "__rn" FROM ${q(t.table)} t0 WHERE ${cond.sql} AND ${w}) WHERE "__rn" > ?${take !== undefined ? ' AND "__rn" <= ?' : ''} ORDER BY ${toCols.map(c => q(c)).join(', ')}, "__rn"`;
        params.push(skip);
        if (take !== undefined) params.push(skip + take);
      } else {
        sql = `SELECT t0.* FROM ${q(t.table)} t0 WHERE ${cond.sql} AND ${w} ORDER BY ${orderSql}`;
      }
      rawChildren.push(...this.sql.all(sql, params));
    }
    const hydrated = this.hydrate(f.type, rawChildren, childArgs, depth);
    const groups = new Map<string, Record<string, unknown>[]>();
    rawChildren.forEach((raw, i) => {
      const k = keyOf(toCols.map(c => raw[c]));
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(hydrated[i]);
    });
    rows.forEach((r, i) => {
      const list = groups.get(keyOf(fromCols.map(c => r[c]))) ?? [];
      out[i][key] = f.list ? list : (list[0] ?? null);
    });
  }
}

/** Collision-free composite key (NUL bytes in values cannot merge two keys). */
const keyOf = (vals: unknown[]): string => JSON.stringify(vals);

function uniqueKeys(rows: Record<string, unknown>[], cols: string[]): unknown[][] {
  const m = new Map<string, unknown[]>();
  for (const r of rows) {
    const vals = cols.map(c => r[c]);
    if (vals.some(v => v === null || v === undefined)) continue;
    m.set(keyOf(vals), vals);
  }
  return [...m.values()];
}

/** Key tuples chunked so key params + `extra()` child params stay within the bound-parameter budget. */
function* chunkKeys(keys: unknown[][], width: number, extra: () => number): Generator<unknown[][]> {
  // single-column keys travel as ONE json_each parameter; composite keys cost `width` params per tuple
  if (width === 1) {
    for (let i = 0; i < keys.length; i += 5000) yield keys.slice(i, i + 5000);
    return;
  }
  const budget = MAX_BOUND - extra() - 2;
  const per = Math.floor(budget / width);
  if (per < 1)
    throw new Error('prisma-lite: the nested where leaves no room for composite key parameters');
  for (let i = 0; i < keys.length; i += per) yield keys.slice(i, i + per);
}

/** `col IN (json_each)` for one-column keys (1 parameter); OR of AND-ed equalities for composite keys. */
function keyCondition(
  cols: string[],
  keys: unknown[][],
  alias: string,
  params: unknown[],
  forCount: boolean
): { sql: string; params: unknown[] } {
  const own: unknown[] = [];
  let sql: string;
  if (cols.length === 1) {
    own.push(JSON.stringify(keys.map(k => k[0])));
    sql = `${alias}.${q(cols[0])} IN (SELECT value FROM json_each(?))`;
  } else {
    sql = `(${keys.map(vals => `(${cols.map((c, i) => (own.push(vals[i]), `${alias}.${q(c)} = ?`)).join(' AND ')})`).join(' OR ')})`;
  }
  void forCount;
  params.push(...own);
  return { sql, params: own };
}

function inList(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('prisma-lite: in/notIn need an array');
  if (v.length > 50_000) throw new Error('prisma-lite: in/notIn list is too long');
  return v;
}

function cursorWhere(m: ModelMeta, cursor: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  const uniques = m.uniques.concat([m.pk]);
  for (const [k, v] of Object.entries(cursor)) {
    const hit = uniques.find(u => u.length > 1 && u.join('_') === k);
    if (hit && isPlain(v)) Object.assign(out, v);
    else out[k] = v;
  }
  const ok = uniques.some(u =>
    u.every(f => own(out, f) && out[f] !== undefined && out[f] !== null)
  );
  if (!ok) throw new Error('prisma-lite: cursor must be a complete unique key');
  return { ...out };
}

// LIKE is case-insensitive for ASCII in SQLite; Prisma (no `mode`) is case-sensitive. This extra predicate
// restores exact-case semantics with instr/substr (both case-sensitive).
function caseSensitiveCheck(op: string, col: string, params: unknown[], v: string): string {
  params.push(v);
  const n = [...v].length;
  if (op === 'contains') return `instr(${col}, ?) > 0`;
  if (op === 'startsWith') return `substr(${col}, 1, ${n}) = ?`;
  return `substr(${col}, length(${col}) - ${n - 1}) = ?`;
}
