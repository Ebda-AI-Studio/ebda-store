import { Prisma } from '@prisma/client';
import { Engine, MAX_PARAMS } from './engine';
import { encode } from './codec';
import { expandUnique } from './unique';
import { newNow, newUuid } from './entropy';
import { enumRankSql } from './enum-order';
import type { ModelMeta, RelationField, ScalarField, WriteGuard } from './types';

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
  // workerd/D1 append `: SQLITE_CONSTRAINT...` to the engine message; the column list must not carry it
  const msg = (e instanceof Error ? e.message : String(e)).replace(/: SQLITE_[A-Z_]+.*$/s, '');
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
  /** The StoreDO's own store id: when set, no row may be written with any other `storeId` (no RLS inside a DO). */
  private readonly ownStoreId: string | undefined;
  private readonly guard: WriteGuard | undefined;
  constructor(
    meta: ConstructorParameters<typeof Engine>[0],
    sql: ConstructorParameters<typeof Engine>[1],
    opts: { storeId?: string; guard?: WriteGuard } = {}
  ) {
    super(meta, sql);
    this.ownStoreId = opts.storeId;
    this.guard = opts.guard;
  }

  /**
   * RPC write guard (Ruling CF-R7-4): called wherever a row of `model` is written, linked or deleted, whatever path
   * reached it. Fails closed: a model that is not writable, or a stock column in `data`, throws before the statement runs.
   */
  private allow(model: string, data?: Row): void {
    const g = this.guard;
    if (!g) return;
    if (!g.writable.has(model))
      throw Object.assign(new Error(`${model} is not ported to the StoreDO write path`), {
        code: 'MODEL_NOT_WRITABLE',
      });
    const cols = g.stock[model];
    if (cols && data)
      for (const c of cols)
        if (data[c] !== undefined)
          throw Object.assign(new Error(`${model}: stock columns are not written here`), {
            code: 'STOCK_WRITE_REFUSED',
          });
  }

  private assertStore(m: ModelMeta, values: Row): void {
    if (this.ownStoreId === undefined || !own(m.fields, 'storeId')) return;
    if (values.storeId === undefined) values.storeId = this.ownStoreId;
    else if (values.storeId !== this.ownStoreId)
      throw new Error("prisma-lite: a write may only carry this store's storeId");
  }

  private externalValue(m: ModelMeta, prop: string, v: unknown): unknown {
    if (prop === 'storeId' && this.ownStoreId !== undefined && v !== this.ownStoreId)
      throw new Error("prisma-lite: a write may only carry this store's storeId");
    return encode(this.scalar(m, prop), v);
  }

  /** A nested write may not set the parent's key, nor re-point the child through the back-relation. */
  private assertNoFkInData(m: ModelMeta, data: Row, fkProps: string[]): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (fkProps.includes(k))
        throw new Error(
          `prisma-lite: a nested write must not set the relation key ${JSON.stringify(k)}`
        );
      const f = own(m.fields, k) ? m.fields[k] : undefined;
      if (f && f.kind === 'relation' && f.fromProps?.some(p => fkProps.includes(p)))
        throw new Error(
          `prisma-lite: a nested write must not re-point ${JSON.stringify(k)} (the back-relation)`
        );
    }
  }

  // ------------------------------------------------------------- helpers
  private run(sql: string, params: unknown[]): number {
    try {
      return this.sql.run(sql, params).changes;
    } catch (e) {
      throw mapDbError(e);
    }
  }

  private defaultValue(f: ScalarField, now: Date): { has: boolean; value?: unknown } {
    const d = f.default;
    if (d === undefined) return { has: false };
    if (d === 'uuid()' || d === 'cuid()') return { has: true, value: newUuid() };
    if (d === 'now()') return { has: true, value: now };
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
      omit: args.omit,
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
    this.allow(model, data);
    if (parentFk) this.assertNoFkInData(m, data, Object.keys(parentFk));
    const now = newNow();
    const values: Row = {};
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
        if (op.connect) {
          this.allow(f.type); // linking to a row of a model the DO does not own is a write path too
          target = this.requireUnique(f.type, op.connect as Row);
        } else if (op.create)
          target = this.insert(f.type, this.model(f.type), op.create as Row, undefined);
        else if (op.connectOrCreate) {
          const coc = op.connectOrCreate as Row;
          this.allow(f.type); // the FOUND branch links without inserting, so the insert hook alone would not see it
          target =
            this.findUnique(f.type, coc.where as Row) ??
            this.insert(f.type, this.model(f.type), coc.create as Row, undefined);
        } else throw new Error(`prisma-lite: unsupported nested write on ${model}.${k}`);
        const tm = this.model(f.type);
        f.fromProps!.forEach((fp, i) => (values[fp] = readProp(tm, target!, f.toProps![i], this)));
      } else afterRel.push([k, f, v]);
    }
    if (parentFk) Object.assign(values, parentFk); // the parent's key is applied LAST: nothing in `data` can override it
    this.assertStore(m, values);
    const cols: string[] = [];
    const binds: unknown[] = [];
    let autoId = false;
    for (const [name, f] of Object.entries(m.fields)) {
      if (f.kind === 'relation') continue;
      let v = values[name];
      if (v === undefined) {
        if (f.updatedAt) v = now;
        else {
          const d = this.defaultValue(f, now);
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
    const fk = (): Row => {
      const out = Object.fromEntries(
        f.toProps!.map((tp, i) => [tp, parentValues[f.fromProps![i]]])
      );
      if (Object.values(out).some(v => v === undefined || v === null))
        throw new Error('prisma-lite: the parent key is not set; refusing a nested write');
      return out;
    };
    for (const [name, arg] of Object.entries(op)) {
      switch (name) {
        case 'create':
          for (const d of Array.isArray(arg) ? arg : [arg]) this.insert(f.type, tm, d as Row, fk());
          break;
        case 'createMany': {
          const { data, skipDuplicates } = arg as { data: Row[]; skipDuplicates?: boolean };
          this.createMany(f.type, { data, skipDuplicates }, fk());
          break;
        }
        case 'connect':
          for (const w of Array.isArray(arg) ? arg : [arg]) this.connectOne(f.type, w as Row, fk());
          break;
        default:
          throw new Error(`prisma-lite: unsupported nested write ${name} on ${model}.${key}`);
      }
    }
    void parent;
  }

  createMany(model: string, args: Args, parentFk?: Row): { count: number } {
    const m = this.model(model);
    let count = 0;
    const rows = Array.isArray(args.data) ? (args.data as Row[]) : [args.data as Row];
    for (const d of rows) {
      if (!d || typeof d !== 'object')
        throw new Error('prisma-lite: createMany data must be objects');
      for (const k of Object.keys(d))
        if (own(m.fields, k) && m.fields[k].kind === 'relation')
          throw new Error('prisma-lite: createMany cannot carry relation fields');
      try {
        this.insert(model, m, d, parentFk);
        count++;
      } catch (e) {
        if (args.skipDuplicates && (e as { code?: string })?.code === 'P2002') continue;
        throw e;
      }
    }
    return { count };
  }

  // ------------------------------------------------------------- reads used by writes
  /** EVERY nested unique selector goes through here: a complete, non-null, plain-valued key or it throws. */
  uniqueWhere(model: string, where: Row): Row {
    return expandUnique(this.meta, model, where);
  }

  findUnique(model: string, where: Row): Row | undefined {
    return this.pkRows(model, this.uniqueWhere(model, where), 1)[0];
  }

  /** Re-parent exactly one row chosen by a unique selector (0 -> P2025, never more than 1). */
  private connectOne(model: string, selector: Row, data: Row): void {
    const rows = this.pkRows(model, this.uniqueWhere(model, selector), 2);
    if (rows.length !== 1)
      throw knownError(
        'P2025',
        'An operation failed because it depends on one or more records that were required but not found. No record was found for a nested connect.',
        { cause: 'Record not found.' }
      );
    this.applyUpdate(model, this.model(model), this.pkWhere(this.model(model), rows[0]), data);
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
    // a primary-key update moves the row: re-read by the NEW key
    const data = (args.data ?? {}) as Row;
    const moved: Row = { ...hit };
    for (const p of m.pk) {
      const nv = data[p];
      if (nv !== undefined && (typeof nv !== 'object' || nv instanceof Date))
        moved[p] = valueToRaw(this.scalar(m, p), nv);
    }
    return this.reread(model, moved, args);
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
    this.allow(model, data);
    if (
      this.ownStoreId !== undefined &&
      data.storeId !== undefined &&
      data.storeId !== this.ownStoreId
    )
      throw new Error("prisma-lite: a write may only carry this store's storeId");
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
              sets.push(`${col} = ${col} ${op === 'increment' ? '+' : '-'} ?`); // NULL stays NULL, like SQL / Postgres
              binds.push(encode(f, arg));
              break;
            case 'multiply':
              if (f.scale) throw new Error('prisma-lite: multiply on Decimal is not supported');
              if (typeof arg !== 'number' || !Number.isFinite(arg))
                throw new Error('prisma-lite: multiply needs a finite number');
              sets.push(`${col} = ${col} * ?`);
              binds.push(arg);
              break;
            case 'divide':
              if (f.scale) throw new Error('prisma-lite: divide on Decimal is not supported');
              if (typeof arg !== 'number' || !Number.isFinite(arg) || arg === 0)
                throw new Error('prisma-lite: divide needs a finite non-zero number');
              sets.push(`${col} = ${col} / ?`);
              binds.push(arg);
              break;
            case 'push': {
              if (!f.list) throw new Error('prisma-lite: push needs a list field');
              const items = Array.isArray(arg) ? arg : [arg]; // Prisma appends each element of an array
              if (items.length === 0 || items.length > 20)
                throw new Error('prisma-lite: push takes 1 to 20 elements');
              let expr = col;
              for (const it of items) {
                expr = `json_insert(${expr}, '$[#]', json(?))`;
                binds.push(JSON.stringify(encode({ ...f, list: false }, it)));
              }
              sets.push(`${col} = ${expr}`);
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
              binds.push(this.externalValue(m, fp, (op.connect as Row)[f.toProps![i]]))
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
              binds.push(encode(this.scalar(m, fp), readProp(tm, t, f.toProps![i], this)))
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
    if (
      hasUpdatedAt &&
      data[hasUpdatedAt[0]] === undefined &&
      (sets.length > 0 || nested.length > 0)
    ) {
      sets.push(`${q((hasUpdatedAt[1] as ScalarField).column)} = ?`);
      binds.push(encode(hasUpdatedAt[1] as ScalarField, newNow()));
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
    const fkVals = (): Row => {
      const out = Object.fromEntries(f.toProps!.map((tp, i) => [tp, parent[f.fromProps![i]]]));
      // compileWhere skips `undefined`, so an unset parent key would silently widen the scope to every row
      if (Object.values(out).some(v => v === undefined || v === null))
        throw new Error('prisma-lite: the parent key is not set; refusing a nested write');
      return out;
    };
    const noFk = (data: unknown): Row => {
      if (!data || typeof data !== 'object')
        throw new Error('prisma-lite: nested data must be an object');
      this.assertNoFkInData(tm, data as Row, f.toProps!);
      return data as Row;
    };
    // The parent FK scope is ANDed, never spread: a caller selector cannot override it, and a selector that names an
    // FK property is refused outright.
    const scoped = (extra?: Row): Row => {
      if (extra === undefined) return fkVals();
      for (const k of Object.keys(extra))
        if (f.toProps!.includes(k))
          throw new Error(
            `prisma-lite: a nested selector must not set the relation key ${JSON.stringify(k)}`
          );
      return { AND: [fkVals(), extra] };
    };
    const childWhere = scoped;
    const uniqueScoped = (sel: Row): Row => scoped(this.uniqueWhere(f.type, sel));
    const countOrThrow = (n: number): void => {
      if (n === 0)
        throw knownError(
          'P2025',
          'An operation failed because it depends on one or more records that were required but not found. No record was found for a nested write.',
          { cause: 'Record not found.' }
        );
    };
    for (const [name, arg] of Object.entries(op)) {
      switch (name) {
        case 'create':
          for (const d of Array.isArray(arg) ? arg : [arg])
            this.insert(f.type, tm, d as Row, fkVals());
          break;
        case 'createMany':
          this.createMany(
            f.type,
            { data: (arg as Row).data, skipDuplicates: (arg as Row).skipDuplicates },
            fkVals()
          );
          break;
        case 'connect':
          for (const w of Array.isArray(arg) ? arg : [arg])
            this.connectOne(f.type, w as Row, fkVals());
          break;
        case 'disconnect':
          for (const w of Array.isArray(arg) ? arg : [arg])
            this.updateWhere(
              f.type,
              uniqueScoped(w as Row),
              Object.fromEntries(f.toProps!.map(tp => [tp, null]))
            );
          break;
        case 'set': {
          const next = (arg as Row[]).map(w => this.uniqueWhere(f.type, w)); // validate every selector BEFORE clearing
          this.updateWhere(
            f.type,
            childWhere(),
            Object.fromEntries(f.toProps!.map(tp => [tp, null]))
          );
          for (const w of next) this.connectOne(f.type, w, fkVals());
          break;
        }
        case 'deleteMany':
          this.deleteMany(f.type, {
            // a list of filters is a UNION in Prisma (each entry deletes its own matches)
            where: { AND: [childWhere(), { OR: Array.isArray(arg) ? arg : [arg ?? {}] }] },
          });
          break;
        case 'delete':
          for (const w of Array.isArray(arg) ? arg : [arg])
            countOrThrow(this.deleteMany(f.type, { where: uniqueScoped(w as Row) }).count);
          break;
        case 'updateMany':
          this.updateWhere(
            f.type,
            { AND: [childWhere(), (arg as Row).where ?? {}] },
            noFk((arg as Row).data)
          );
          break;
        case 'update': {
          const a = arg as Row;
          const list = Array.isArray(a) ? a : [a];
          for (const u of list)
            countOrThrow(this.updateWhere(f.type, uniqueScoped(u.where as Row), noFk(u.data)));
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
    this.deleteByPk(model, m, hit);
    return out;
  }

  deleteMany(model: string, args: Args = {}): { count: number } {
    const m = this.model(model);
    const rows = this.pkRows(model, args.where ?? {});
    for (const r of rows) this.deleteByPk(model, m, r);
    return { count: rows.length };
  }

  private deleteByPk(model: string, m: ModelMeta, pk: Row): void {
    this.allow(model);
    const where = m.pk.map(p => `${q(this.scalar(m, p).column)} = ?`).join(' AND ');
    this.run(
      `DELETE FROM ${q(m.table)} WHERE ${where}`,
      m.pk.map(p => rawToBind(this.scalar(m, p), pk[p]))
    );
  }

  // ------------------------------------------------------------- aggregates
  aggregate(model: string, args: Args): Row {
    onlyArgs(args, ['where', '_count', '_sum', '_avg', '_min', '_max']);
    const m = this.model(model);
    const params: unknown[] = [];
    const where = this.compileWhere(model, args.where, 't0', params);
    const parts: string[] = [];
    const out: Row = {};
    const shape: [string, string, string][] = [];
    if (args._count) {
      // Prisma: `_count: true` answers a NUMBER (`_count: 5`), `_count: { _all: true }` an object (`{ _all: 5 }`); '' marks the scalar
      if (args._count === true) {
        parts.push('count(*) AS "_count__all"');
        shape.push(['_count', '', '_count__all']);
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
        if (
          (fn === '_sum' || fn === '_avg') &&
          !['Int', 'Float', 'Decimal', 'BigInt'].includes(sf.type)
        )
          throw new Error(`prisma-lite: ${fn} needs a numeric field`);
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
      if (fn === '_count' && f === '') {
        out._count = Number(row[alias]);
        continue;
      }
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
    onlyArgs(args, [
      'by',
      'where',
      '_count',
      '_sum',
      '_avg',
      '_min',
      '_max',
      'orderBy',
      'having',
      'take',
      'skip',
    ]);
    const m = this.model(model);
    const by = (Array.isArray(args.by) ? args.by : [args.by]) as string[];
    if (by.length === 0 || by.some(b => typeof b !== 'string'))
      throw new Error('prisma-lite: groupBy needs at least one field in `by`');
    const params: unknown[] = [];
    const where = this.compileWhere(model, args.where, 't0', params);
    const byCols = by.map(b => `t0.${q(this.scalar(m, b).column)}`);
    const sel = by.map((b, i) => `${byCols[i]} AS ${q(`k__${b}`)}`);
    const shape: [string, string, string][] = [];
    if (args._count) {
      // `_count: true` answers a number per group, as Prisma does (see aggregate)
      if (args._count === true)
        (sel.push('count(*) AS "_count___all"'), shape.push(['_count', '', '_count___all']));
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
    if (args.having !== undefined) sql += ` HAVING ${this.groupHaving(m, by, args.having, params)}`;
    if (args.orderBy) {
      const ob = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Row[];
      const parts: string[] = [];
      for (const item of ob)
        for (const [k, dir] of Object.entries(item)) {
          if (k === '_count' || k === '_sum' || k === '_avg' || k === '_min' || k === '_max') {
            // order by an aggregate: { _sum: { price: 'desc' } } / { _count: { _all: 'desc' } }
            for (const [f, d] of Object.entries(dir as Row)) {
              const dd = dirOf(d);
              const expr =
                k === '_count' && f === '_all'
                  ? 'count(*)'
                  : `${k === '_count' ? 'count' : k.slice(1).toUpperCase()}(t0.${q(this.scalar(m, f).column)})`;
              if (k !== '_count' && k !== '_min' && k !== '_max') this.numericOnly(m, f, k);
              parts.push(`${expr} ${dd} NULLS ${dd === 'ASC' ? 'LAST' : 'FIRST'}`);
            }
            continue;
          }
          if (!by.includes(k))
            throw new Error('prisma-lite: groupBy orderBy must name a group field');
          const sf = this.scalar(m, k);
          const col = q(`k__${k}`);
          const d = dirOf(dir);
          parts.push(
            `${sf.kind === 'enum' && sf.enum ? enumRankSql(col, sf.enum, this.meta.enums) : col} ${d} NULLS ${d === 'ASC' ? 'LAST' : 'FIRST'}`
          );
        }
      if (parts.length) sql += ` ORDER BY ${parts.join(', ')}`;
    }
    const take = args.take;
    const skip = args.skip;
    if (take !== undefined || skip !== undefined) {
      if (take !== undefined && (!Number.isInteger(take) || take < 0))
        throw new Error('prisma-lite: groupBy take must be a non-negative integer');
      if (skip !== undefined && (!Number.isInteger(skip) || skip < 0))
        throw new Error('prisma-lite: groupBy skip must be a non-negative integer');
      sql += ` LIMIT ${take === undefined ? -1 : take} OFFSET ${skip ?? 0}`;
    }
    const rows = this.sql.all(sql, params);
    return rows.map(r => {
      const o: Row = {};
      for (const b of by) o[b] = rawToJs(this.scalar(m, b), r[`k__${b}`]);
      for (const [fn, f, alias] of shape) {
        if (fn === '_count' && f === '') {
          o._count = Number(r[alias]);
          continue;
        }
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

  private numericOnly(m: ModelMeta, field: string, fn: string): void {
    if (!['Int', 'Float', 'Decimal', 'BigInt'].includes(this.scalar(m, field).type))
      throw new Error(`prisma-lite: ${fn} needs a numeric field`);
  }

  /**
   * groupBy `having`: `{ price: { _avg: { gt: 5 } } }` (an aggregate of a field), a plain filter on a group key
   * (`{ status: 'active' }` / `{ status: { in: [...] } }`), and AND / OR / NOT of those. Anything else throws.
   */
  private groupHaving(
    m: ModelMeta,
    by: string[],
    having: unknown,
    params: unknown[],
    depth = 0
  ): string {
    if (depth > 8) throw new Error('prisma-lite: having nests too deep');
    if (!having || typeof having !== 'object' || Array.isArray(having))
      throw new Error('prisma-lite: having must be an object');
    const OPS: Record<string, string> = {
      equals: '=',
      not: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    };
    const cond = (expr: string, f: ScalarField, filter: unknown): string => {
      const parts: string[] = [];
      const entries =
        filter !== null && typeof filter === 'object' && !Array.isArray(filter)
          ? Object.entries(filter as Row)
          : [['equals', filter] as [string, unknown]];
      for (const [op, val] of entries) {
        if (op === 'in' || op === 'notIn') {
          if (!Array.isArray(val) || val.length === 0)
            throw new Error(`prisma-lite: having ${op} needs a non-empty array`);
          for (const v of val) params.push(encode(f, v));
          parts.push(`${expr} ${op === 'in' ? 'IN' : 'NOT IN'} (${val.map(() => '?').join(', ')})`);
        } else if (op in OPS) {
          if (val === null) parts.push(`${expr} IS ${op === 'not' ? 'NOT ' : ''}NULL`);
          else {
            params.push(f.type === 'Float' ? val : encode(f, val));
            parts.push(`${expr} ${OPS[op]} ?`);
          }
        } else throw new Error(`prisma-lite: unsupported having operator ${JSON.stringify(op)}`);
      }
      if (parts.length === 0) throw new Error('prisma-lite: empty having filter');
      return parts.join(' AND ');
    };
    const out: string[] = [];
    for (const [k, v] of Object.entries(having as Row)) {
      if (k === 'AND' || k === 'OR') {
        const list = (Array.isArray(v) ? v : [v]) as unknown[];
        if (list.length === 0) throw new Error(`prisma-lite: empty having ${k}`);
        out.push(
          `(${list.map(w => this.groupHaving(m, by, w, params, depth + 1)).join(k === 'AND' ? ' AND ' : ' OR ')})`
        );
      } else if (k === 'NOT') {
        const list = (Array.isArray(v) ? v : [v]) as unknown[];
        out.push(
          `NOT (${list.map(w => this.groupHaving(m, by, w, params, depth + 1)).join(' AND ')})`
        );
      } else {
        const f = this.scalar(m, k);
        const col = `t0.${q(f.column)}`;
        const aggs =
          v !== null && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v as Row).filter(x => x.startsWith('_'))
            : [];
        if (aggs.length === 0) {
          if (!by.includes(k))
            throw new Error(`prisma-lite: having on ${k} needs an aggregate or a group field`);
          out.push(cond(col, f, v));
        } else {
          if (aggs.length !== Object.keys(v as Row).length)
            throw new Error('prisma-lite: having mixes aggregate and plain operators');
          for (const fn of aggs) {
            if (!['_count', '_sum', '_avg', '_min', '_max'].includes(fn))
              throw new Error(`prisma-lite: unsupported having aggregate ${JSON.stringify(fn)}`);
            if (fn === '_sum' || fn === '_avg') this.numericOnly(m, k, fn);
            if (f.type === 'Decimal')
              throw new Error('prisma-lite: having on a Decimal aggregate is not supported');
            const expr = fn === '_count' ? `count(${col})` : `${fn.slice(1).toUpperCase()}(${col})`;
            out.push(
              cond(
                expr,
                fn === '_count' ? { ...f, type: 'Int', kind: 'scalar' as const } : f,
                (v as Row)[fn]
              )
            );
          }
        }
      }
    }
    if (out.length === 0) throw new Error('prisma-lite: empty having');
    return out.join(' AND ');
  }
}

function onlyArgs(args: Args, allowed: string[]): void {
  for (const k of Object.keys(args))
    if (!allowed.includes(k))
      throw new Error(`prisma-lite: unsupported aggregate argument ${JSON.stringify(k)}`);
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
