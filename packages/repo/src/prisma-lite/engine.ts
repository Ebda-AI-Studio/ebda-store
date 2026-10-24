import type { FieldMeta, Meta, ModelMeta, RelationField, ScalarField, SqlRunner } from './types';
import { decode, encode } from './codec';

/** Cloudflare DO SQLite allows 100 bound parameters per statement: every IN list is chunked. */
export const MAX_PARAMS = 90;

type Where = Record<string, unknown> | undefined;
type Args = Record<string, any>;

const q = (s: string) => `"${s}"`;

export class Engine {
  private alias = 0;
  constructor(
    readonly meta: Meta,
    readonly sql: SqlRunner
  ) {}

  model(name: string): ModelMeta {
    const m = this.meta.models[name];
    if (!m) throw new Error(`prisma-lite: model ${name} is not in this database`);
    return m;
  }

  private nextAlias(): string {
    return `t${++this.alias}`;
  }

  scalar(m: ModelMeta, name: string): ScalarField {
    const f = m.fields[name];
    if (!f || f.kind === 'relation') throw new Error(`prisma-lite: ${name} is not a scalar field`);
    return f;
  }

  // ---------------------------------------------------------------- where
  compileWhere(modelName: string, where: Where, alias: string, params: unknown[]): string {
    const m = this.model(modelName);
    if (!where) return '1';
    const parts: string[] = [];
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined) continue;
      if (key === 'AND' || key === 'OR') {
        const list = (Array.isArray(val) ? val : [val]) as Where[];
        const sub = list.map(w => this.compileWhere(modelName, w, alias, params));
        if (sub.length === 0) parts.push(key === 'AND' ? '1' : '0');
        else parts.push(`(${sub.join(key === 'AND' ? ' AND ' : ' OR ')})`);
        continue;
      }
      if (key === 'NOT') {
        const list = (Array.isArray(val) ? val : [val]) as Where[];
        for (const w of list) parts.push(`NOT (${this.compileWhere(modelName, w, alias, params)})`);
        continue;
      }
      const f = m.fields[key];
      if (!f) throw new Error(`prisma-lite: unknown field ${modelName}.${key} in where`);
      if (f.kind === 'relation') {
        parts.push(
          this.compileRelationFilter(m, key, f, val as Record<string, unknown>, alias, params)
        );
      } else {
        parts.push(this.compileScalarFilter(f, `${alias}.${q(f.column)}`, val, params));
      }
    }
    return parts.length ? parts.join(' AND ') : '1';
  }

  private compileScalarFilter(
    f: ScalarField,
    col: string,
    val: unknown,
    params: unknown[]
  ): string {
    if (val === null) return `${col} IS NULL`;
    const isOps =
      typeof val === 'object' &&
      val !== null &&
      !(val instanceof Date) &&
      !Array.isArray(val) &&
      !isDecimal(val);
    if (!isOps) {
      params.push(encode(f, val));
      return `${col} = ?`;
    }
    const ops = val as Record<string, unknown>;
    const insensitive = ops.mode === 'insensitive';
    const out: string[] = [];
    const bind = (v: unknown) => {
      params.push(encode(f, v));
      return '?';
    };
    for (const [op, v] of Object.entries(ops)) {
      if (v === undefined || op === 'mode') continue;
      switch (op) {
        case 'equals':
          out.push(v === null ? `${col} IS NULL` : `${col} = ${bind(v)}`);
          break;
        case 'not':
          if (v === null) out.push(`${col} IS NOT NULL`);
          else if (typeof v === 'object' && !(v instanceof Date) && !isDecimal(v))
            out.push(`NOT (${this.compileScalarFilter(f, col, v, params)})`);
          else out.push(`(${col} IS NULL OR ${col} <> ${bind(v)})`); // SQL <> would drop NULL rows; Prisma keeps them
          break;
        case 'in': {
          const list = v as unknown[];
          if (list.length === 0) out.push('0');
          else out.push(`${col} IN (${list.map(bind).join(', ')})`);
          break;
        }
        case 'notIn': {
          const list = v as unknown[];
          if (list.length === 0) out.push('1');
          else out.push(`(${col} IS NULL OR ${col} NOT IN (${list.map(bind).join(', ')}))`);
          break;
        }
        case 'lt':
          out.push(`${col} < ${bind(v)}`);
          break;
        case 'lte':
          out.push(`${col} <= ${bind(v)}`);
          break;
        case 'gt':
          out.push(`${col} > ${bind(v)}`);
          break;
        case 'gte':
          out.push(`${col} >= ${bind(v)}`);
          break;
        case 'contains':
        case 'startsWith':
        case 'endsWith': {
          const esc = String(v).replace(/[\\%_]/g, '\\$&');
          const pat = op === 'contains' ? `%${esc}%` : op === 'startsWith' ? `${esc}%` : `%${esc}`;
          params.push(pat);
          // SQLite LIKE is ASCII-case-insensitive; GLOB-free exact case needs instr for case-sensitive. Prisma's
          // default (no mode) is case-sensitive on Postgres, so use instr/substr for that and LIKE for insensitive.
          if (insensitive) out.push(`${col} LIKE ? ESCAPE '\\'`);
          else
            out.push(
              `${col} LIKE ? ESCAPE '\\' AND ${caseSensitiveCheck(op, col, params, String(v))}`
            );
          break;
        }
        default:
          throw new Error(`prisma-lite: unsupported scalar filter ${op}`);
      }
    }
    return out.length ? `(${out.join(' AND ')})` : '1';
  }

  private compileRelationFilter(
    m: ModelMeta,
    key: string,
    f: RelationField,
    val: Record<string, unknown> | null,
    alias: string,
    params: unknown[]
  ): string {
    if (f.external)
      throw new Error(
        `prisma-lite: ${m.table}.${key} points at another database and cannot be filtered`
      );
    const t = this.model(f.type);
    const a = this.nextAlias();
    const join = f.from!.map((c, i) => `${a}.${q(f.to![i])} = ${alias}.${q(c)}`).join(' AND ');
    const exists = (w: Where, negate = false) => {
      const cond = this.compileWhere(f.type, w, a, params);
      return `${negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${q(t.table)} ${a} WHERE ${join} AND ${cond})`;
    };
    if (val === null) return `NOT EXISTS (SELECT 1 FROM ${q(t.table)} ${a} WHERE ${join})`;
    if (f.list) {
      const parts: string[] = [];
      if ('some' in val) parts.push(exists(val.some as Where));
      if ('none' in val) parts.push(exists(val.none as Where, true));
      if ('every' in val) parts.push(exists({ NOT: val.every as Where }, true));
      return parts.length ? parts.join(' AND ') : '1';
    }
    // to-one: { is, isNot } or the filter itself
    if ('is' in val || 'isNot' in val) {
      const parts: string[] = [];
      if ('is' in val)
        parts.push(val.is === null ? exists(undefined, true) : exists(val.is as Where));
      if ('isNot' in val)
        parts.push(val.isNot === null ? exists(undefined) : exists(val.isNot as Where, true));
      return parts.join(' AND ');
    }
    return exists(val as Where);
  }

  // ------------------------------------------------------------- orderBy
  compileOrderBy(modelName: string, orderBy: unknown, alias: string, params: unknown[]): string {
    const m = this.model(modelName);
    const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<
      string,
      any
    >[];
    const out: string[] = [];
    for (const item of list) {
      for (const [key, dir] of Object.entries(item)) {
        const f = m.fields[key] as FieldMeta | undefined;
        if (key === '_count') {
          for (const [rel, d] of Object.entries(dir as Record<string, string>)) {
            const rf = m.fields[rel] as RelationField;
            out.push(`${this.countSubquery(rf, alias)} ${String(d).toUpperCase()}`);
          }
          continue;
        }
        if (!f) throw new Error(`prisma-lite: unknown orderBy field ${modelName}.${key}`);
        if (f.kind !== 'relation') {
          const d = typeof dir === 'string' ? dir : dir.sort;
          const nulls =
            typeof dir === 'object' && dir.nulls ? ` NULLS ${String(dir.nulls).toUpperCase()}` : '';
          out.push(`${alias}.${q(f.column)} ${String(d).toUpperCase()}${nulls}`);
        } else if (!f.list && !f.external) {
          // to-one: order by the related row's column through a correlated subquery
          const t = this.model(f.type);
          const a = this.nextAlias();
          const join = f
            .from!.map((c, i) => `${a}.${q(f.to![i])} = ${alias}.${q(c)}`)
            .join(' AND ');
          const [[col, d]] = Object.entries(dir as Record<string, string>);
          const cf = this.scalar(t, col);
          out.push(
            `(SELECT ${a}.${q(cf.column)} FROM ${q(t.table)} ${a} WHERE ${join}) ${String(d).toUpperCase()}`
          );
        } else throw new Error(`prisma-lite: unsupported orderBy on relation ${key}`);
      }
    }
    void params;
    return out.join(', ');
  }

  private countSubquery(rf: RelationField, alias: string): string {
    const t = this.model(rf.type);
    const a = this.nextAlias();
    const join = rf.from!.map((c, i) => `${a}.${q(rf.to![i])} = ${alias}.${q(c)}`).join(' AND ');
    return `(SELECT count(*) FROM ${q(t.table)} ${a} WHERE ${join})`;
  }

  // --------------------------------------------------------------- reads
  /** Run a find; returns decoded rows with select/include relations attached. */
  findMany(modelName: string, args: Args = {}): Record<string, unknown>[] {
    const m = this.model(modelName);
    const params: unknown[] = [];
    const a = 't0';
    const where = this.compileWhere(modelName, args.where, a, params);
    let order = this.compileOrderBy(modelName, args.orderBy, a, params);
    if (args.take !== undefined && args.take < 0)
      throw new Error('prisma-lite: negative take is not supported');
    // Stable order for paging when the caller gave none (Prisma orders by the primary key implicitly for cursors only).
    if (!order && (args.take !== undefined || args.skip))
      order = m.pk.map(p => `${a}.${q(this.scalar(m, p).column)}`).join(', ');
    let sql = `SELECT ${a}.* FROM ${q(m.table)} ${a} WHERE ${where}`;
    if (args.cursor) {
      const [[cf, cv]] = Object.entries(args.cursor as Record<string, unknown>);
      const f = this.scalar(m, cf);
      params.push(encode(f, cv));
      sql += ` AND ${a}.${q(f.column)} >= ?`;
    }
    if (order) sql += ` ORDER BY ${order}`;
    if (args.take !== undefined) sql += ` LIMIT ${Number(args.take)}`;
    if (args.skip)
      sql += `${args.take === undefined ? ' LIMIT -1' : ''} OFFSET ${Number(args.skip)}`;
    const rows = this.sql.all(sql, params);
    return this.hydrate(modelName, rows, args);
  }

  count(modelName: string, args: Args = {}): number {
    const m = this.model(modelName);
    const params: unknown[] = [];
    const where = this.compileWhere(modelName, args.where, 't0', params);
    let sql = `SELECT count(*) AS n FROM ${q(m.table)} t0 WHERE ${where}`;
    if (args.take !== undefined || args.skip) {
      sql = `SELECT count(*) AS n FROM (SELECT 1 FROM ${q(m.table)} t0 WHERE ${where} LIMIT ${args.take ?? -1} OFFSET ${args.skip ?? 0})`;
    }
    return Number(this.sql.all(sql, params)[0].n);
  }

  private hydrate(
    modelName: string,
    rows: Record<string, unknown>[],
    args: Args
  ): Record<string, unknown>[] {
    const m = this.model(modelName);
    const select = args.select as Record<string, any> | undefined;
    const include = args.include as Record<string, any> | undefined;
    const scalarKeys = Object.keys(m.fields).filter(k => m.fields[k].kind !== 'relation');
    const wanted = select ? scalarKeys.filter(k => select[k]) : scalarKeys;
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
      const f = m.fields[key];
      if (!f || f.kind !== 'relation') continue;
      if (f.external) throw new Error(`prisma-lite: ${modelName}.${key} lives in another database`);
      this.attachRelation(m, f, key, rows, out, spec === true ? {} : spec);
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
            k => m.fields[k].kind === 'relation' && (m.fields[k] as RelationField).list
          )
        : Object.keys(sel).filter(k => sel[k]);
    for (const rel of rels) {
      const f = m.fields[rel] as RelationField;
      const t = this.model(f.type);
      const cw = typeof sel[rel] === 'object' ? sel[rel].where : undefined;
      const fromCol = f.from![0];
      const keys = [
        ...new Set(rows.map(r => r[fromCol]).filter(v => v !== null && v !== undefined)),
      ];
      const counts = new Map<unknown, number>();
      for (const chunk of chunked(keys)) {
        const params: unknown[] = [];
        const w = this.compileWhere(f.type, cw, 't0', params);
        const sql = `SELECT t0.${q(f.to![0])} AS k, count(*) AS n FROM ${q(t.table)} t0 WHERE t0.${q(f.to![0])} IN (${chunk.map(() => '?').join(',')}) AND ${w} GROUP BY t0.${q(f.to![0])}`;
        for (const r of this.sql.all(sql, [...chunk, ...params])) counts.set(r.k, Number(r.n));
      }
      rows.forEach((r, i) => {
        const c = (out[i]._count ??= {}) as Record<string, number>;
        c[rel] = counts.get(r[fromCol]) ?? 0;
      });
    }
  }

  private attachRelation(
    m: ModelMeta,
    f: RelationField,
    key: string,
    rows: Record<string, unknown>[],
    out: Record<string, unknown>[],
    spec: Args
  ): void {
    const t = this.model(f.type);
    const fromCols = f.from!;
    const toCols = f.to!;
    // composite keys are rare; support them with tuple IN via OR of ANDs when > 1
    const keyOf = (row: Record<string, unknown>, cols: string[]) =>
      cols.map(c => row[c]).join('\u0000');
    const parentKeys = new Map<string, unknown[]>();
    for (const r of rows) {
      const vals = fromCols.map(c => r[c]);
      if (vals.some(v => v === null || v === undefined)) continue;
      parentKeys.set(vals.join('\u0000'), vals);
    }
    const childArgs: Args = {
      where: spec.where,
      orderBy: spec.orderBy,
      select: spec.select,
      include: spec.include,
    };
    const children: Record<string, unknown>[] = [];
    const rawChildren: Record<string, unknown>[] = [];
    const uniqueKeys = [...parentKeys.values()];
    for (const chunk of chunked(uniqueKeys, Math.floor(MAX_PARAMS / toCols.length))) {
      const params: unknown[] = [];
      const cond = chunk
        .map(
          vals =>
            `(${toCols.map((c, i) => (params.push(vals[i]), `t0.${q(c)} = ?`)).join(' AND ')})`
        )
        .join(' OR ');
      const w = this.compileWhere(f.type, spec.where, 't0', params);
      const order = this.compileOrderBy(f.type, spec.orderBy, 't0', params);
      const sql = `SELECT t0.* FROM ${q(t.table)} t0 WHERE (${cond}) AND ${w}${order ? ` ORDER BY ${order}` : ''}`;
      // `params` order: cond params were pushed before where params, matching the SQL text order.
      rawChildren.push(...this.sql.all(sql, params));
    }
    // Hydrate the children (nested select/include) in the order fetched, remembering their join key.
    const hydrated = this.hydrate(f.type, rawChildren, childArgs);
    rawChildren.forEach((raw, i) => children.push({ __k: keyOf(raw, toCols), ...hydrated[i] }));
    // Children reached through select that omits the join column still need grouping: grouped by raw key above.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const c of children) {
      const k = c.__k as string;
      delete c.__k;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
    }
    rows.forEach((r, i) => {
      const k = keyOf(r, fromCols);
      let list = groups.get(k) ?? [];
      if (f.list) {
        if (spec.skip) list = list.slice(Number(spec.skip));
        if (spec.take !== undefined) list = list.slice(0, Number(spec.take));
        out[i][key] = list;
      } else out[i][key] = list[0] ?? null;
    });
    void m;
  }
}

function chunked<T>(list: T[], size = MAX_PARAMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function isDecimal(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
    'd' in (v as object)
  );
}

// LIKE is case-insensitive for ASCII in SQLite; Prisma (no `mode`) is case-sensitive. This extra predicate
// restores exact-case semantics with instr/substr (both case-sensitive).
function caseSensitiveCheck(op: string, col: string, params: unknown[], v: string): string {
  params.push(v);
  if (op === 'contains') return `instr(${col}, ?) > 0`;
  if (op === 'startsWith') return `substr(${col}, 1, ${[...v].length}) = ?`;
  return `substr(${col}, -${[...v].length}) = ?`;
}
