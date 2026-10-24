import { Prisma } from '@prisma/client';
import { Engine, MAX_PARAMS } from './engine';
import { encode } from './codec';
import type { ModelMeta, RelationField, ScalarField } from './types';

type Args = Record<string, any>;
type Row = Record<string, unknown>;
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const q = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    throw new Error(`prisma-lite: refusing identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
};

/** A Prisma error with the shape the API's error handler reads (`code`, `meta.target` = column names). */
export function knownError(code: string, message: string, meta?: Record<string, unknown>): Error {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta,
  });
}

/** SQLite/DO constraint errors -> Prisma codes (P2002 unique, P2003 foreign key, P2011 null, P2004 check). */
export function mapDbError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  let m = msg.match(/UNIQUE constraint failed: (.+?)(?:$|\s*\()/);
  if (m) {
    const cols = m[1].startsWith('index ')
      ? [m[1].slice(6).replace(/['"]/g, '')]
      : m[1].split(',').map(s => s.trim().split('.').pop()!);
    return knownError('P2002', `Unique constraint failed on the fields: (${cols.join(',')})`, {
      target: cols,
    });
  }
  if (/FOREIGN KEY constraint failed/.test(msg))
    return knownError('P2003', 'Foreign key constraint violated', { field_name: 'unknown' });
  m = msg.match(/NOT NULL constraint failed: (.+)$/);
  if (m)
    return knownError('P2011', `Null constraint violation on the ${m[1]}`, {
      constraint: [m[1].split('.').pop()],
    });
  m = msg.match(/CHECK constraint failed: (.+)$/);
  if (m)
    return knownError('P2004', `A constraint failed on the database: ${m[1]}`, {
      database_error: m[1],
    });
  return e; // triggers (RAISE ABORT) and anything else keep their message (GOLD_PRICE_MANAGED is read from it)
}

/** Prisma write operations over the DO's synchronous SQLite. Transactions are the caller's (client.ts). */
export class WriteEngine extends Engine {
  // ------------------------------------------------------------- helpers
  private run(sql: string, params: unknown[]): number {
    try {
      return this.sql.run(sql, params).changes;
    } catch (e) {
      throw mapDbError(e);
    }
  }

  private defaultValue(f: ScalarField): { has: boolean; value?: unknown } {
    const d = f.default;
    if (d === undefined) return { has: false };
    if (d === 'uuid()' || d === 'cuid()') return { has: true, value: crypto.randomUUID() };
    if (d === 'now()') return { has: true, value: new Date() };
    if (d === 'autoincrement()') return { has: false };
    if (d === 'true' || d === 'false') return { has: true, value: d === 'true' };
    if (/^-?\d+(\.\d+)?$/.test(d)) return { has: true, value: Number(d) };
    if (d.startsWith('"')) {
      const s = JSON.parse(d) as string;
      return { has: true, value: f.type === 'Json' ? JSON.parse(s) : s };
    }
    if (d.startsWith('[')) return { has: true, value: JSON.parse(d) };
    if (/^\w+$/.test(d) && f.kind === 'enum') return { has: true, value: d };
    throw new Error(`prisma-lite: unsupported default ${d}`);
  }

  private bindValue(f: ScalarField, v: unknown): unknown {
    if (v === Prisma.DbNull) return null;
    if (v === Prisma.JsonNull) return 'null';
    return encode(f, v);
  }

  /** Unique selector (+ any extra filters, as Prisma allows) -> ids of matching rows (<= 1 when `one`). */
  private pkRows(model: string, where: Row, limit?: number): Row[] {
    const m = this.model(model);
    const params: unknown[] = [];
    const cond = this.compileWhere(model, where, 't0', params);
    const cols = m.pk.map(p => `t0.${q(this.scalar(m, p).column)} AS ${q(p)}`).join(', ');
    let sql = `SELECT ${cols} FROM ${q(m.table)} t0 WHERE ${cond}`;
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return this.sql.all(sql, params);
  }

  private pkWhere(m: ModelMeta, row: Row): Row {
    return Object.fromEntries(m.pk.map(p => [p, row[p]]));
  }

  private reread(model: string, row: Row, args: Args): Row {
    const m = this.model(model);
    // decode the pk values through the field codec: pkRows returns raw SQLite values
    const where = Object.fromEntries(m.pk.map(p => [p, rawToJs(this.scalar(m, p), row[p])]));
    const out = this.findMany(model, {
      where,
      select: args.select,
      include: args.include,
      take: 1,
    })[0];
    if (!out)
      throw knownError(
        'P2025',
        'An operation failed because it depends on one or more records that were required but not found.',
        { cause: 'Record not found.' }
      );
    return out;
  }

  // ------------------------------------------------------------- create
  create(model: string, args: Args): Row {
    const m = this.model(model);
    const row = this.insert(model, m, args.data ?? {}, undefined);
    return this.reread(model, row, args);
  }

  /** Insert one row (and its nested creates). `parentFk` pre-fills the foreign key of a nested child. */
  private insert(model: string, m: ModelMeta, data: Row, parentFk: Row | undefined): Row {
    const values: Row = { ...(parentFk ?? {}) };
    const afterRel: [string, RelationField, any][] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (!own(m.fields, k)) throw new Error(`prisma-lite: unknown field ${model}.${k} in data`);
      const f = m.fields[k];
      if (f.kind !== 'relation') {
        values[k] = v;
        continue;
      }
      if (f.external) {
        // relation to a model in another database (Store, User): only `connect` is meaningful; set the FK column
        if (v && typeof v === 'object' && 'connect' in v) {
          const c = (v as Row).connect as Row;
          f.fromProps!.forEach((fp, i) => (values[fp] = c[f.toProps![i]]));
          continue;
        }
        throw new Error(
          `prisma-lite: ${model}.${k} lives in another database; only connect is supported`
        );
      }
      if (f.owner) {
        // this row holds the FK: resolve (or create) the target first
        const op = v as Row;
        let target: Row | undefined;
        if (op.connect) target = this.requireUnique(f.type, op.connect as Row);
        else if (op.create)
          target = this.insert(f.type, this.model(f.type), op.create as Row, undefined);
        else if (op.connectOrCreate) {
          const coc = op.connectOrCreate as Row;
          target =
            this.findUnique(f.type, coc.where as Row) ??
            this.insert(f.type, this.model(f.type), coc.create as Row, undefined);
        } else throw new Error(`prisma-lite: unsupported nested write on ${model}.${k}`);
        const tm = this.model(f.type);
        f.fromProps!.forEach((fp, i) => (values[fp] = readProp(tm, target!, f.toProps![i], this)));
      } else afterRel.push([k, f, v]);
    }
    const cols: string[] = [];
    const binds: unknown[] = [];
    let autoId = false;
    for (const [name, f] of Object.entries(m.fields)) {
      if (f.kind === 'relation') continue;
      let v = values[name];
      if (v === undefined) {
        if (f.updatedAt) v = new Date();
        else {
          const d = this.defaultValue(f);
          if (d.has) v = d.value;
          else if (f.default === 'autoincrement()') {
            autoId = true;
            continue;
          } else if (f.optional) continue;
        }
        if (v !== undefined) values[name] = v;
      }
      if (v === undefined) continue; // required without default: the NOT NULL constraint reports it
      cols.push(q(f.column));
      binds.push(this.bindValue(f, v));
    }
    const sql = cols.length
      ? `INSERT INTO ${q(m.table)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      : `INSERT INTO ${q(m.table)} DEFAULT VALUES`;
    this.run(sql, binds);
    if (autoId) values[m.pk[0]] = this.sql.all('SELECT last_insert_rowid() AS id', [])[0].id;
    const row: Row = Object.fromEntries(
      m.pk.map(p => [p, valueToRaw(this.scalar(m, p), values[p])])
    );
    // inverse relations: children created/connected after the parent exists
    for (const [k, f, v] of afterRel) this.nestedInverse(model, m, row, values, k, f, v as Row);
    return row;
  }

  private nestedInverse(
    model: string,
    _m: ModelMeta,
    parent: Row,
    parentValues: Row,
    key: string,
    f: RelationField,
    op: Row
  ): void {
    const tm = this.model(f.type);
    // child FK props <- parent referenced props
    const fk = (): Row =>
      Object.fromEntries(f.toProps!.map((tp, i) => [tp, parentValues[f.fromProps![i]]]));
    for (const [name, arg] of Object.entries(op)) {
      switch (name) {
        case 'create':
          for (const d of Array.isArray(arg) ? arg : [arg]) this.insert(f.type, tm, d as Row, fk());
          break;
        case 'createMany': {
          const { data, skipDuplicates } = arg as { data: Row[]; skipDuplicates?: boolean };
          this.createMany(f.type, { data: data.map(d => ({ ...d, ...fk() })), skipDuplicates });
          break;
        }
        case 'connect':
          for (const w of Array.isArray(arg) ? arg : [arg])
            this.updateWhere(f.type, this.uniqueWhere(f.type, w as Row), fk());
          break;
        default:
          throw new Error(`prisma-lite: unsupported nested write ${name} on ${model}.${key}`);
      }
    }
    void parent;
  }

  createMany(model: string, args: Args): { count: number } {
    const m = this.model(model);
    let count = 0;
    for (const d of args.data as Row[]) {
      try {
        this.insert(model, m, d, undefined);
        count++;
      } catch (e) {
        if (args.skipDuplicates && (e as { code?: string })?.code === 'P2002') continue;
        throw e;
      }
    }
    return { count };
  }

  // ------------------------------------------------------------- reads used by writes
  uniqueWhere(_model: string, where: Row): Row {
    return where;
  }

  findUnique(model: string, where: Row): Row | undefined {
    return this.pkRows(model, where, 1)[0];
  }

  private requireUnique(model: string, where: Row): Row {
    const r = this.findUnique(model, where);
    if (!r)
      throw knownError(
        'P2025',
        'An operation failed because it depends on one or more records that were required but not found. No record was found for a nested connect.',
        { cause: 'Record not found.' }
      );
    return r;
  }

  // ------------------------------------------------------------- update
  update(model: string, args: Args): Row {
    const m = this.model(model);
    const hit = this.pkRows(model, args.where, 1)[0];
    if (!hit)
      throw knownError(
        'P2025',
        'An operation failed because it depends on one or more records that were required but not found. Record to update not found.',
        { cause: 'Record to update not found.' }
      );
    this.applyUpdate(model, m, this.pkWhere(m, hit), args.data ?? {});
    return this.reread(model, hit, args);
  }

  updateMany(model: string, args: Args): { count: number } {
    const m = this.model(model);
    const rows = this.pkRows(model, args.where ?? {});
    for (const r of rows) this.applyUpdate(model, m, this.pkWhere(m, r), args.data ?? {});
    return { count: rows.length };
  }

  private updateWhere(model: string, where: Row, data: Row): number {
    const m = this.model(model);
    const rows = this.pkRows(model, where);
    for (const r of rows) this.applyUpdate(model, m, this.pkWhere(m, r), data);
    return rows.length;
  }

  /** `where` here is a full primary-key selector of one row; the SET list is built from `data`. */
  private applyUpdate(model: string, m: ModelMeta, pkSel: Row, data: Row): void {
    const sets: string[] = [];
    const binds: unknown[] = [];
    const values: Row = {};
    const nested: [string, RelationField, Row][] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (!own(m.fields, k)) throw new Error(`prisma-lite: unknown field ${model}.${k} in data`);
      const f = m.fields[k];
      if (f.kind === 'relation') {
        nested.push([k, f, v as Row]);
        continue;
      }
      const col = q(f.column);
      if (
        v &&
        typeof v === 'object' &&
        !(v instanceof Date) &&
        !Array.isArray(v) &&
        v !== Prisma.DbNull &&
        v !== Prisma.JsonNull &&
        !isDecimalLike(v) &&
        f.type !== 'Json'
      ) {
        const ops = v as Row;
        for (const [op, arg] of Object.entries(ops)) {
          switch (op) {
            case 'set':
              sets.push(`${col} = ?`);
              binds.push(this.bindValue(f, arg));
              values[k] = arg;
              break;
            case 'increment':
            case 'decrement':
              sets.push(`${col} = COALESCE(${col}, 0) ${op === 'increment' ? '+' : '-'} ?`);
              binds.push(encode(f, arg));
              break;
            case 'multiply':
              if (f.scale) throw new Error('prisma-lite: multiply on Decimal is not supported');
              sets.push(`${col} = ${col} * ?`);
              binds.push(arg);
              break;
            case 'divide':
              if (f.scale) throw new Error('prisma-lite: divide on Decimal is not supported');
              sets.push(`${col} = ${col} / ?`);
              binds.push(arg);
              break;
            case 'push': {
              if (!f.list) throw new Error('prisma-lite: push needs a list field');
              sets.push(`${col} = json_insert(${col}, '$[#]', json(?))`);
              binds.push(JSON.stringify(arg));
              break;
            }
            default:
              throw new Error(`prisma-lite: unsupported update operator ${op}`);
          }
        }
        continue;
      }
      sets.push(`${col} = ?`);
      binds.push(this.bindValue(f, v));
      values[k] = v;
    }
    // owner-side nested connect/disconnect set this row's FK columns
    for (const [k, f, op] of nested) {
      if (f.external) {
        if ('connect' in op)
          f.fromProps!.forEach(
            (fp, i) => (
              sets.push(`${q(this.scalar(m, fp).column)} = ?`),
              binds.push((op.connect as Row)[f.toProps![i]])
            )
          );
        else
          throw new Error(
            `prisma-lite: ${model}.${k} lives in another database; only connect is supported`
          );
        continue;
      }
      if (f.owner) {
        if (op.connect) {
          const t = this.requireUnique(f.type, op.connect as Row);
          const tm = this.model(f.type);
          f.fromProps!.forEach(
            (fp, i) => (
              sets.push(`${q(this.scalar(m, fp).column)} = ?`),
              binds.push(rawOf(this, tm, t, f.toProps![i]))
            )
          );
        } else if (op.disconnect)
          f.fromProps!.forEach(fp => sets.push(`${q(this.scalar(m, fp).column)} = NULL`));
        else throw new Error(`prisma-lite: unsupported nested update on ${model}.${k}`);
      }
    }
    const hasUpdatedAt = Object.entries(m.fields).find(
      ([, f]) => f.kind !== 'relation' && f.updatedAt
    );
    if (hasUpdatedAt && !(hasUpdatedAt[0] in data) && (sets.length > 0 || nested.length > 0)) {
      sets.push(`${q((hasUpdatedAt[1] as ScalarField).column)} = ?`);
      binds.push(encode(hasUpdatedAt[1] as ScalarField, new Date()));
    }
    if (sets.length) {
      const where = m.pk.map(p => `${q(this.scalar(m, p).column)} = ?`).join(' AND ');
      this.run(`UPDATE ${q(m.table)} SET ${sets.join(', ')} WHERE ${where}`, [
        ...binds,
        ...m.pk.map(p => rawToBind(this.scalar(m, p), pkSel[p])),
      ]);
    }
    // inverse-side nested writes need the (possibly updated) parent values
    if (nested.some(([, f]) => !f.owner && !f.external)) {
      const cur = this.findMany(model, { where: pkSel, take: 1 })[0] as Row;
      for (const [k, f, op] of nested) {
        if (f.owner || f.external) continue;
        this.nestedInverseUpdate(model, m, cur, k, f, op);
      }
    }
  }

  private nestedInverseUpdate(
    model: string,
    _m: ModelMeta,
    parent: Row,
    key: string,
    f: RelationField,
    op: Row
  ): void {
    const tm = this.model(f.type);
    const fkVals = (): Row =>
      Object.fromEntries(f.toProps!.map((tp, i) => [tp, parent[f.fromProps![i]]]));
    const childWhere = (extra?: Row): Row => ({ ...fkVals(), ...(extra ?? {}) });
    for (const [name, arg] of Object.entries(op)) {
      switch (name) {
        case 'create':
          for (const d of Array.isArray(arg) ? arg : [arg])
            this.insert(f.type, tm, d as Row, fkVals());
          break;
        case 'createMany':
          this.createMany(f.type, {
            data: ((arg as Row).data as Row[]).map(d => ({ ...d, ...fkVals() })),
            skipDuplicates: (arg as Row).skipDuplicates,
          });
          break;
        case 'connect':
          for (const w of Array.isArray(arg) ? arg : [arg])
            this.updateWhere(f.type, w as Row, fkVals());
          break;
        case 'disconnect':
          for (const w of Array.isArray(arg) ? arg : [arg])
            this.updateWhere(
              f.type,
              childWhere(w as Row),
              Object.fromEntries(f.toProps!.map(tp => [tp, null]))
            );
          break;
        case 'set': {
          this.updateWhere(
            f.type,
            childWhere(),
            Object.fromEntries(f.toProps!.map(tp => [tp, null]))
          );
          for (const w of arg as Row[]) this.updateWhere(f.type, w, fkVals());
          break;
        }
        case 'deleteMany':
          this.deleteMany(f.type, {
            where: { AND: [childWhere(), ...(Array.isArray(arg) ? arg : arg ? [arg] : [])] },
          });
          break;
        case 'delete':
          for (const w of Array.isArray(arg) ? arg : [arg])
            this.deleteMany(f.type, { where: childWhere(w as Row) });
          break;
        case 'updateMany':
          this.updateWhere(
            f.type,
            { AND: [childWhere(), (arg as Row).where ?? {}] },
            (arg as Row).data as Row
          );
          break;
        case 'update': {
          const a = arg as Row;
          const list = Array.isArray(a) ? a : [a];
          for (const u of list) this.updateWhere(f.type, childWhere(u.where as Row), u.data as Row);
          break;
        }
        default:
          throw new Error(`prisma-lite: unsupported nested write ${name} on ${model}.${key}`);
      }
    }
  }

  // ------------------------------------------------------------- upsert / delete
  upsert(model: string, args: Args): Row {
    const m = this.model(model);
    const hit = this.pkRows(model, args.where, 1)[0];
    if (hit) {
      this.applyUpdate(model, m, this.pkWhere(m, hit), args.update ?? {});
      return this.reread(model, hit, args);
    }
    const row = this.insert(model, m, args.create ?? {}, undefined);
    return this.reread(model, row, args);
  }

  delete(model: string, args: Args): Row {
    const m = this.model(model);
    const hit = this.pkRows(model, args.where, 1)[0];
    if (!hit)
      throw knownError(
        'P2025',
        'An operation failed because it depends on one or more records that were required but not found. Record to delete does not exist.',
        { cause: 'Record to delete does not exist.' }
      );
    const out = this.reread(model, hit, args); // read BEFORE the delete (FK cascades may remove children)
    this.deleteByPk(m, hit);
    return out;
  }

  deleteMany(model: string, args: Args = {}): { count: number } {
    const m = this.model(model);
    const rows = this.pkRows(model, args.where ?? {});
    for (const r of rows) this.deleteByPk(m, r);
    return { count: rows.length };
  }

  private deleteByPk(m: ModelMeta, pk: Row): void {
    const where = m.pk.map(p => `${q(this.scalar(m, p).column)} = ?`).join(' AND ');
    this.run(
      `DELETE FROM ${q(m.table)} WHERE ${where}`,
      m.pk.map(p => rawToBind(this.scalar(m, p), pk[p]))
    );
  }

  // ------------------------------------------------------------- aggregates
  aggregate(model: string, args: Args): Row {
    const m = this.model(model);
    const params: unknown[] = [];
    const where = this.compileWhere(model, args.where, 't0', params);
    const parts: string[] = [];
    const out: Row = {};
    const shape: [string, string, string][] = [];
    if (args._count) {
      if (args._count === true) {
        parts.push('count(*) AS "_count__all"');
        shape.push(['_count', '_all', '_count__all']);
      } else
        for (const [f, on] of Object.entries(args._count)) {
          if (!on) continue;
          if (f === '_all')
            (parts.push('count(*) AS "_count___all"'),
              shape.push(['_count', '_all', '_count___all']));
          else
            (parts.push(`count(t0.${q(this.scalar(m, f).column)}) AS ${q(`_count__${f}`)}`),
              shape.push(['_count', f, `_count__${f}`]));
        }
    }
    for (const fn of ['_sum', '_avg', '_min', '_max'] as const) {
      for (const [f, on] of Object.entries((args[fn] as Row) ?? {})) {
        if (!on) continue;
        const sf = this.scalar(m, f);
        const sqlFn = fn.slice(1).toUpperCase();
        parts.push(`${sqlFn}(t0.${q(sf.column)}) AS ${q(`${fn}__${f}`)}`);
        shape.push([fn, f, `${fn}__${f}`]);
      }
    }
    if (parts.length === 0)
      throw new Error('prisma-lite: aggregate needs at least one of _count/_sum/_avg/_min/_max');
    const row = this.sql.all(
      `SELECT ${parts.join(', ')} FROM ${q(m.table)} t0 WHERE ${where}`,
      params
    )[0];
    for (const [fn, f, alias] of shape) {
      const bucket = (out[fn] ??= {}) as Row;
      const raw = row[alias];
      if (fn === '_count') bucket[f] = Number(raw);
      else if (raw === null || raw === undefined) bucket[f] = null;
      else
        bucket[f] =
          fn === '_avg'
            ? decodeAgg(this.scalar(m, f), Number(raw), true)
            : decodeAgg(this.scalar(m, f), raw, false);
    }
    return out;
  }

  groupBy(model: string, args: Args): Row[] {
    const m = this.model(model);
    const by = (Array.isArray(args.by) ? args.by : [args.by]) as string[];
    const params: unknown[] = [];
    const where = this.compileWhere(model, args.where, 't0', params);
    const byCols = by.map(b => `t0.${q(this.scalar(m, b).column)}`);
    const sel = by.map((b, i) => `${byCols[i]} AS ${q(`k__${b}`)}`);
    const shape: [string, string, string][] = [];
    if (args._count) {
      if (args._count === true)
        (sel.push('count(*) AS "_count___all"'), shape.push(['_count', '_all', '_count___all']));
      else
        for (const [f, on] of Object.entries(args._count)) {
          if (!on) continue;
          if (f === '_all')
            (sel.push('count(*) AS "_count___all"'),
              shape.push(['_count', '_all', '_count___all']));
          else
            (sel.push(`count(t0.${q(this.scalar(m, f).column)}) AS ${q(`_count__${f}`)}`),
              shape.push(['_count', f, `_count__${f}`]));
        }
    }
    for (const fn of ['_sum', '_avg', '_min', '_max'] as const)
      for (const [f, on] of Object.entries((args[fn] as Row) ?? {})) {
        if (!on) continue;
        sel.push(
          `${fn.slice(1).toUpperCase()}(t0.${q(this.scalar(m, f).column)}) AS ${q(`${fn}__${f}`)}`
        );
        shape.push([fn, f, `${fn}__${f}`]);
      }
    let sql = `SELECT ${sel.join(', ')} FROM ${q(m.table)} t0 WHERE ${where} GROUP BY ${byCols.join(', ')}`;
    if (args.orderBy) {
      const ob = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Row[];
      const parts: string[] = [];
      for (const item of ob)
        for (const [k, dir] of Object.entries(item)) {
          if (k === '_count' || k === '_sum' || k === '_avg' || k === '_min' || k === '_max')
            throw new Error('prisma-lite: groupBy orderBy on an aggregate is not supported');
          if (!by.includes(k))
            throw new Error('prisma-lite: groupBy orderBy must name a group field');
          parts.push(`${q(`k__${k}`)} ${dirOf(dir)}`);
        }
      if (parts.length) sql += ` ORDER BY ${parts.join(', ')}`;
    }
    if (args.having) throw new Error('prisma-lite: groupBy having is not supported');
    const rows = this.sql.all(sql, params);
    return rows.map(r => {
      const o: Row = {};
      for (const b of by) o[b] = rawToJs(this.scalar(m, b), r[`k__${b}`]);
      for (const [fn, f, alias] of shape) {
        const bucket = (o[fn] ??= {}) as Row;
        const raw = r[alias];
        if (fn === '_count') bucket[f] = Number(raw);
        else if (raw === null || raw === undefined) bucket[f] = null;
        else
          bucket[f] =
            fn === '_avg'
              ? decodeAgg(this.scalar(m, f), Number(raw), true)
              : decodeAgg(this.scalar(m, f), raw, false);
      }
      return o;
    });
  }
}

function dirOf(v: unknown): 'ASC' | 'DESC' {
  const d = typeof v === 'string' ? v.toLowerCase() : '';
  if (d === 'asc') return 'ASC';
  if (d === 'desc') return 'DESC';
  throw new Error('prisma-lite: sort direction must be asc or desc');
}

function isDecimalLike(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
    'd' in (v as object)
  );
}

import { decode } from './codec';
function rawToJs(f: ScalarField, raw: unknown): unknown {
  return decode(f, raw);
}
function valueToRaw(f: ScalarField, v: unknown): unknown {
  return encode(f, v);
}
function rawToBind(_f: ScalarField, raw: unknown): unknown {
  return raw;
}
function rawOf(engine: Engine, tm: ModelMeta, row: Row, prop: string): unknown {
  void engine;
  void tm;
  return row[prop];
}
function readProp(tm: ModelMeta, row: Row, prop: string, engine: Engine): unknown {
  // `row` holds raw pk values only; a referenced non-pk unique column needs a read
  if (own(row, prop)) return decode(engine.scalar(tm, prop), row[prop]);
  throw new Error(`prisma-lite: relation references a non-primary-key column ${prop}`);
}
function decodeAgg(f: ScalarField, raw: unknown, isAvg: boolean): unknown {
  if (f.scale) {
    const d = decode(f, Math.round(Number(raw)));
    return d;
  }
  if (isAvg) return Number(raw);
  if (f.type === 'DateTime') return new Date(Number(raw));
  if (f.type === 'BigInt') return BigInt(raw as number);
  return raw;
}
void MAX_PARAMS;
