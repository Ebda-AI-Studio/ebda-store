#!/usr/bin/env node
// Generates the Cloudflare SQLite schema from packages/database/prisma/schema.prisma (Phase 1, tasks
// 1.2 to 1.4). Outputs, all committed:
//   migrations/store/0001_init.sql        StoreDO (114 models + store_profile/store_config + additions)
//   migrations/platform/0001_init.sql     D1 ebda-platform (21 models + additions)
//   src/{store,platform}/schema.generated.ts   Drizzle table definitions (columns + primary keys)
//   generated/manifest.json               tables, column counts, decimals, skipped raw invariants
// Rules (plan section 5, task 1.3): enums -> CHECK; Json -> TEXT + json_valid; DateTime -> INTEGER epoch
// ms UTC; Decimal -> INTEGER scaled by 10^scale; String[] -> TEXT JSON array; money already integer
// piastres; foreign keys only where both ends live in the same database.
// Run: node packages/cf-schema/scripts/generate.mjs [--check]  (--check fails when output is stale)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseSchema } from './prisma-parse.mjs';
import { classifyStoreColumns } from './store-split.mjs';
import { readRawInvariants, pgExprToSqlite, pgPredicateToSqlite } from './pg-raw.mjs';
import {
  LATE_COLUMN_MIGRATIONS,
  extraColumns,
  extraIndexes,
  extraModels,
} from './cf-additions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '../..');
const prismaDir = path.join(repo, 'packages/database/prisma');

export const MAX_COLUMNS = 100; // Cloudflare DO SQLite: 100 columns per table

const NOW_SQL = "(CAST(unixepoch('subsec') * 1000 AS INTEGER))";
const qid = s => `"${s}"`;
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;
const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export function build() {
  const schema = parseSchema(fs.readFileSync(path.join(prismaDir, 'schema.prisma'), 'utf8'));
  const split = JSON.parse(fs.readFileSync(path.join(pkg, 'model-split.json'), 'utf8'));
  const enums = new Map(schema.enums.map(e => [e.name, e.values]));
  const byName = new Map(schema.models.map(m => [m.name, m]));

  for (const name of byName.keys())
    if (!split[name]) throw new Error(`model ${name} is missing from model-split.json`);
  for (const name of Object.keys(split))
    if (!byName.has(name)) throw new Error(`model-split.json names unknown model ${name}`);

  // ---- 1. assemble the per-database model lists ------------------------------------------------
  const clone = m => JSON.parse(JSON.stringify(m));
  const addCols = m => {
    const c = clone(m);
    for (const col of extraColumns[m.name] ?? []) c.fields.push(clone(col));
    for (const [mn, cols] of extraIndexes)
      if (mn === m.name) c.indexes.push({ fields: cols.map(field => ({ field })), map: null });
    return c;
  };

  const storeModel = byName.get('Store');
  const storeScalars = storeModel.fields.filter(x => x.kind !== 'relation');
  const storeBuckets = classifyStoreColumns(storeScalars.map(x => x.name));
  const fieldOf = n => storeModel.fields.find(x => x.name === n);

  const dbs = { 'store-do': [], d1: [] };
  for (const [name, { target }] of Object.entries(split)) {
    if (target !== 'store-do' && target !== 'd1') continue;
    if (name === 'Store') continue;
    dbs[target].push(addCols(byName.get(name)));
  }
  // Store -> D1 `stores` (directory + mirrored fields)
  const d1Store = clone(storeModel);
  const d1Names = new Set([...storeBuckets.d1Only, ...storeBuckets.mirror]);
  d1Store.fields = d1Store.fields.filter(x => x.kind !== 'relation' && d1Names.has(x.name));
  d1Store.indexes = d1Store.indexes.filter(ix => ix.fields.every(x => d1Names.has(x.field)));
  // CF-only D1 columns (storage_backend): the router reads them from the directory row, never from the DO.
  for (const col of extraColumns.Store ?? []) d1Store.fields.push(clone(col));
  dbs.d1.push(d1Store);
  // Store -> DO `store_profile` (mirror + profile) and `store_config` (config)
  const mkPart = (name, dbName, names, idNote) => {
    const fields = [];
    const sid = clone(fieldOf('id'));
    sid.name = 'storeId';
    sid.column = 'store_id';
    sid.attrs = { id: true };
    fields.push(sid);
    for (const n of names) {
      if (n === 'id') continue;
      const c = clone(fieldOf(n));
      delete c.attrs.unique; // uniqueness is enforced in D1 only
      if (c.attrs.relation) delete c.attrs.relation;
      fields.push(c);
    }
    return { name, dbName, fields, uniques: [], indexes: [], id: null, note: idNote };
  };
  dbs['store-do'].push(
    mkPart(
      'StoreProfile',
      'store_profile',
      [...storeBuckets.mirror, ...storeBuckets.profile],
      'Store split (task 1.4): D1 mirror fields (write-through) plus branding, content, SEO, contact and pixels. One row, id = the DO store id.'
    ),
    mkPart(
      'StoreConfig',
      'store_config',
      storeBuckets.config,
      'Store split (task 1.4): commerce, flags, integrations, accounting and AI switches. One row.'
    )
  );
  for (const target of ['store-do', 'd1'])
    for (const m of extraModels[target]) dbs[target].push(clone(m));

  // ---- 2. raw Postgres invariants -------------------------------------------------------------
  const raw = readRawInvariants(path.join(prismaDir, 'migrations'));

  const out = {};
  const manifest = { generatedBy: 'packages/cf-schema/scripts/generate.mjs', databases: {} };
  const decimals = [];
  const skippedAll = [];

  for (const target of ['store-do', 'd1']) {
    const models = dbs[target];
    const sameDb = new Map(models.map(m => [m.name, m]));
    const tables = [];
    for (const m of models) tables.push(buildTable(m, { enums, sameDb, decimals, target }));
    const tableByName = new Map(tables.map(t => [t.name, t]));
    // origin lookup for Store-derived tables
    const sourceTables = new Map(); // prisma dbName -> emitted tables
    for (const t of tables) {
      const origin = t.origin ?? t.name;
      if (!sourceTables.has(origin)) sourceTables.set(origin, []);
      sourceTables.get(origin).push(t);
    }

    const skipped = [];
    const placed = (manifest.placed ??= { checks: {}, indexes: {} });
    for (const c of raw.checks) {
      const cands = sourceTables.get(c.table);
      if (!cands) {
        skipped.push({
          kind: 'check',
          name: c.name,
          table: c.table,
          reason: tableTargetReason(c.table, byName, split),
        });
        continue;
      }
      const owner = pickOwner(cands, c.expr, byName);
      if (!owner) {
        skipped.push({
          kind: 'check',
          name: c.name,
          table: c.table,
          reason: 'columns are split across emitted tables',
        });
        continue;
      }
      owner.rawChecks.push({ name: c.name, expr: pgPredicateToSqlite(c.expr) });
      (placed.checks[c.name] ??= []).push(`${target}:${owner.name}`);
    }
    for (const ix of raw.indexes) {
      const isRawShape = ix.where || ix.using || /\(/.test(ix.cols.replace(/"\w+"/g, ''));
      if (!isRawShape) continue;
      const cands = sourceTables.get(ix.table);
      if (!cands) {
        skipped.push({
          kind: 'index',
          name: ix.name,
          table: ix.table,
          reason: tableTargetReason(ix.table, byName, split),
        });
        continue;
      }
      if (ix.using && /gin/i.test(ix.using)) {
        // trigram / expression GIN indexes serve Postgres substring search; replaced by FTS5 (plan 2.9, task 3.7)
        skipped.push({
          kind: 'index',
          name: ix.name,
          table: ix.table,
          reason: 'Postgres trigram GIN: replaced by FTS5 (task 3.7)',
        });
        continue;
      }
      const owner = pickOwner(cands, `${ix.cols} ${ix.where ?? ''}`, byName);
      if (!owner) {
        skipped.push({
          kind: 'index',
          name: ix.name,
          table: ix.table,
          reason: 'columns are split across emitted tables',
        });
        continue;
      }
      const cols = pgExprToSqlite(ix.cols);
      const where = ix.where ? pgPredicateToSqlite(ix.where) : null;
      // a raw partial unique supersedes a full unique declared in schema.prisma on the same columns
      const colList = ix.cols
        .replace(/"/g, '')
        .split(',')
        .map(s => s.trim())
        .filter(s => /^\w+$/.test(s));
      if (ix.unique && where) {
        owner.uniques = owner.uniques.filter(u => {
          const same = u.cols.length === colList.length && u.cols.every((c, i) => c === colList[i]);
          if (same)
            manifest.supersededUniques = [
              ...(manifest.supersededUniques ?? []),
              { table: owner.name, unique: u.name, by: ix.name },
            ];
          return !same;
        });
      }
      for (const list of ['indexes', 'uniques']) {
        owner[list] = owner[list].filter(u => {
          if (u.name !== ix.name) return true;
          manifest.supersededUniques = [
            ...(manifest.supersededUniques ?? []),
            { table: owner.name, unique: u.name, by: ix.name },
          ];
          return false;
        });
      }
      owner.rawIndexes.push({ name: ix.name, unique: ix.unique, cols, where });
      (manifest.translatedIndexes ??= []).push({
        name: ix.name,
        table: owner.name,
        db: target,
        unique: ix.unique,
        pgCols: ix.cols,
        pgWhere: ix.where,
      });
      (placed.indexes[ix.name] ??= []).push(`${target}:${owner.name}`);
    }
    for (const t of tables) tableByName.set(t.name, t);
    out[target] = { tables, skipped };
    manifest.databases[target] = {
      tables: tables.length,
      maxColumns: Math.max(...tables.map(t => t.columns.length)),
      columnCounts: Object.fromEntries(tables.map(t => [t.name, t.columns.length])),
    };
    skippedAll.push(...skipped.map(x => ({ ...x, db: target })));
  }
  // a raw invariant is accounted for when exactly one database placed it; otherwise its reasons are listed
  const accounted = [];
  for (const c of raw.checks) {
    const where = manifest.placed.checks[c.name];
    accounted.push({
      kind: 'check',
      name: c.name,
      table: c.table,
      disposition: where ? where.join(',') : reasonFor(skippedAll, 'check', c.name),
    });
  }
  for (const ix of raw.indexes) {
    if (!(ix.where || ix.using || /\(/.test(ix.cols.replace(/"\w+"/g, '')))) continue;
    const where = manifest.placed.indexes[ix.name];
    accounted.push({
      kind: 'index',
      name: ix.name,
      table: ix.table,
      disposition: where ? where.join(',') : reasonFor(skippedAll, 'index', ix.name),
    });
  }
  manifest.rawInvariants = accounted;
  delete manifest.placed;
  manifest.supersededUniques ??= [];
  manifest.meta = buildMeta(schema, split);
  manifest.decimals = decimals;
  manifest.storeSplit = storeBuckets;
  return { out, manifest, schema, split };
}

// Runtime metadata for the Prisma-compatible query layer (packages/repo): per model, its table, columns,
// scalar types, enum values, uniques and RESOLVED relations. Relations to models in another database
// (every `store` relation: Store lives in D1) are marked external and are not traversable in the DO.
function buildMeta(schema, split) {
  const byName = new Map(schema.models.map(m => [m.name, m]));
  const enums = Object.fromEntries(schema.enums.map(e => [e.name, e.values]));
  const out = {};
  for (const m of schema.models) {
    const target = split[m.name].target;
    if (target !== 'store-do' && target !== 'd1') continue;
    const fields = {};
    for (const f of m.fields) {
      if (f.kind === 'unsupported') continue;
      if (f.kind !== 'relation') {
        const dec = (f.attrs.db ?? '').match(/Decimal\((\d+),\s*(\d+)\)/);
        fields[f.name] = {
          kind: f.kind,
          type: f.type,
          column: f.column,
          list: f.list,
          optional: f.optional,
          ...(dec ? { scale: Number(dec[2]) } : {}),
          ...(f.kind === 'enum' ? { enum: f.type } : {}),
          ...(f.attrs.default !== undefined ? { default: f.attrs.default } : {}),
          ...(f.attrs.updatedAt ? { updatedAt: true } : {}),
          ...(f.attrs.id ? { id: true } : {}),
        };
        continue;
      }
      const tm = byName.get(f.type);
      const external = split[f.type].target !== target;
      let rel = { kind: 'relation', type: f.type, list: f.list, optional: f.optional, external };
      const r = f.attrs.relation;
      if (r && r.fields.length) {
        rel = {
          ...rel,
          owner: true,
          from: r.fields.map(n => m.fields.find(x => x.name === n).column),
          fromProps: r.fields,
          to: r.references.map(n => tm.fields.find(x => x.name === n).column),
          toProps: r.references,
          onDelete: r.onDelete,
        };
      } else if (!external) {
        const back = tm.fields.filter(
          g =>
            g.kind === 'relation' &&
            g.type === m.name &&
            g.attrs.relation?.fields.length &&
            (!r?.name || g.attrs.relation.name === r.name)
        );
        if (back.length !== 1)
          throw new Error(
            `cannot resolve inverse of ${m.name}.${f.name} (${back.length} candidates)`
          );
        const g = back[0].attrs.relation;
        rel = {
          ...rel,
          owner: false,
          from: g.references.map(n => m.fields.find(x => x.name === n).column),
          fromProps: g.references,
          to: g.fields.map(n => tm.fields.find(x => x.name === n).column),
          toProps: g.fields,
        };
      }
      fields[f.name] = rel;
    }
    out[m.name] = {
      table: m.dbName,
      db: target,
      pk: m.id ?? m.fields.filter(f => f.attrs.id).map(f => f.name),
      uniques: [
        ...m.fields.filter(f => f.attrs.unique && f.kind !== 'relation').map(f => [f.name]),
        ...m.uniques.map(u => u.fields.map(x => x.field)),
      ],
      fields,
    };
  }
  return { models: out, enums, omit: globalOmit(out) };
}

// The real client's global `omit` (secrets that a full-row read must never return). Parsed from the one place it is
// declared so prisma-lite cannot drift from it; keyed by Prisma model name and limited to models in this database.
function globalOmit(models) {
  const src = fs.readFileSync(path.join(repo, 'packages/database/src/client.ts'), 'utf8');
  const m0 = /^ {2}omit: \{/m.exec(src);
  const at = m0 ? m0.index : -1;
  if (at < 0) throw new Error('packages/database/src/client.ts no longer declares a global omit');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = src.slice(src.indexOf('{', at), end + 1).replace(/\/\/.*$/gm, '');
  const literal = new Function(`return (${body})`)();
  const out = {};
  for (const [delegate, fields] of Object.entries(literal)) {
    const model = delegate[0].toUpperCase() + delegate.slice(1);
    if (!models[model]) continue; // e.g. user: identity, not in this database
    out[model] = Object.keys(fields).filter(k => fields[k] === true);
  }
  return out;
}

function reasonFor(skippedAll, kind, name) {
  const rs = skippedAll.filter(x => x.kind === kind && x.name === name);
  // prefer the most specific reason: a model that targets another database is "elsewhere", not a gap
  const split = rs.find(r => /split across/.test(r.reason));
  if (split) return `UNPLACED: ${split.reason}`;
  const reasons = [...new Set(rs.map(r => r.reason))].filter(
    r => !/targets (store-do|d1)$/.test(r)
  );
  return reasons.length ? `skipped: ${reasons.join('; ')}` : 'UNPLACED';
}

function tableTargetReason(prismaTable, byName, split) {
  for (const m of byName.values()) {
    if (m.dbName === prismaTable) return `model ${m.name} targets ${split[m.name].target}`;
  }
  return 'table not in schema.prisma';
}

// Which emitted table owns a raw invariant: the one whose columns cover every identifier the
// expression uses. Needed because Store is split in three tables.
function pickOwner(cands, expr, byName) {
  const origin = cands[0].origin;
  const model = [...byName.values()].find(m => m.dbName === origin);
  const all = new Set(
    model
      ? model.fields.filter(f => f.kind !== 'relation').map(f => f.column)
      : cands.flatMap(t => t.columns.map(c => c.col))
  );
  for (const t of cands) for (const c of t.columns) all.add(c.col);
  const words = new Set((expr.match(/"?[a-z_][a-z0-9_]*"?/g) ?? []).map(w => w.replace(/"/g, '')));
  const used = [...words].filter(w => all.has(w));
  return cands.find(t => used.every(w => t.columns.some(col => col.col === w))) ?? null;
}

function buildTable(m, ctx) {
  const { enums, sameDb, decimals } = ctx;
  const columns = [];
  const fks = [];
  const uniques = [];
  const indexes = [];
  const fieldByName = new Map(m.fields.map(x => [x.name, x]));
  const colOf = n => {
    const x = fieldByName.get(n);
    if (!x) throw new Error(`${m.name}: index/unique/relation names unknown field ${n}`);
    return x.column;
  };
  const table = m.dbName;

  for (const f of m.fields) {
    if (f.kind === 'relation') continue;
    if (f.kind === 'unsupported')
      throw new Error(`${m.name}.${f.name} is Unsupported(...) and must not be emitted`);
    const col = {
      prop: f.name,
      col: f.column,
      optional: f.optional,
      checks: [],
      note: f.cfNote,
      since: f.cfSince,
    };
    const d = f.attrs.default;
    if (f.list) {
      if (f.type !== 'String')
        throw new Error(`${m.name}.${f.name}: only String[] lists are supported`);
      col.sql = 'TEXT';
      col.ts = { fn: 'text', json: 'string[]' };
      col.checks.push(`json_valid(${qid(f.column)}) AND json_type(${qid(f.column)}) = 'array'`);
    } else if (f.kind === 'enum') {
      const values = f.attrs.enumValues ?? enums.get(f.type);
      if (!values) throw new Error(`${m.name}.${f.name}: unknown enum ${f.type}`);
      col.sql = 'TEXT';
      col.ts = { fn: 'text', enumValues: values };
      col.checks.push(`${qid(f.column)} IN (${values.map(sqlStr).join(', ')})`);
    } else {
      switch (f.type) {
        case 'String':
          col.sql = 'TEXT';
          col.ts = { fn: 'text' };
          break;
        case 'Int':
        case 'BigInt':
          col.sql = 'INTEGER';
          col.ts = { fn: 'integer' };
          break;
        case 'Float':
          col.sql = 'REAL';
          col.ts = { fn: 'real' };
          break;
        case 'Boolean':
          col.sql = 'INTEGER';
          col.ts = { fn: 'integer', mode: 'boolean' };
          col.checks.push(`${qid(f.column)} IN (0, 1)`);
          break;
        case 'DateTime':
          col.sql = 'INTEGER';
          col.ts = { fn: 'integer', mode: 'timestamp_ms' };
          break;
        case 'Json':
          col.sql = 'TEXT';
          col.ts = { fn: 'text', json: 'unknown' };
          col.checks.push(`json_valid(${qid(f.column)})`);
          break;
        case 'Decimal': {
          const m2 = (f.attrs.db ?? '').match(/Decimal\((\d+),\s*(\d+)\)/);
          if (!m2) throw new Error(`${m.name}.${f.name}: Decimal without @db.Decimal(p, s)`);
          const scale = Number(m2[2]);
          col.sql = 'INTEGER';
          col.ts = { fn: 'integer' };
          col.decimalScale = scale;
          decimals.push({
            table,
            column: f.column,
            precision: Number(m2[1]),
            scale,
            representation: `INTEGER = value x 10^${scale}`,
          });
          break;
        }
        default:
          throw new Error(`${m.name}.${f.name}: unsupported type ${f.type}`);
      }
    }
    col.primary = !!f.attrs.id;
    // defaults
    if (d !== undefined) {
      if (d === 'uuid()' || d === 'cuid()') col.appDefault = 'crypto.randomUUID()';
      else if (d === 'now()') col.defaultSql = NOW_SQL;
      else if (d === 'autoincrement()') col.autoincrement = true;
      else if (d === 'dbgenerated("CURRENT_DATE")')
        col.defaultSql = "(CAST(strftime('%s', 'now', 'start of day') AS INTEGER) * 1000)"; // day granularity (SEARCH-T5-6), UTC day start
      else if (d.startsWith('dbgenerated'))
        throw new Error(`${m.name}.${f.name}: dbgenerated default is not portable`);
      else if (d === 'true' || d === 'false') col.defaultSql = d === 'true' ? '1' : '0';
      else if (/^-?\d+(\.\d+)?$/.test(d))
        col.defaultSql = col.decimalScale
          ? String(Math.round(Number(d) * 10 ** col.decimalScale))
          : d;
      else if (d.startsWith('"')) {
        const v = JSON.parse(d);
        col.defaultSql = sqlStr(v);
        col.tsDefault = f.type === 'Json' ? JSON.parse(v) : v;
      } else if (d.startsWith('[')) {
        const arr = JSON.parse(d);
        col.defaultSql = sqlStr(JSON.stringify(arr));
        col.tsDefault = arr;
      } else if (/^\w+$/.test(d) && f.kind === 'enum') {
        col.defaultSql = sqlStr(d);
        col.tsDefault = d;
      } else throw new Error(`${m.name}.${f.name}: unhandled default ${d}`);
      if (f.attrs.default === 'true' || f.attrs.default === 'false')
        col.tsDefault = f.attrs.default === 'true';
      else if (col.tsDefault === undefined && /^-?\d+(\.\d+)?$/.test(d))
        col.tsDefault = Number(col.defaultSql);
    }
    if (f.attrs.updatedAt && !col.defaultSql) col.defaultSql = NOW_SQL;
    columns.push(col);
  }

  // primary key
  let pk = columns.filter(c => c.primary).map(c => c.col);
  if (m.id) pk = m.id.map(colOf);
  if (pk.length === 0) throw new Error(`${m.name} has no primary key`);

  // foreign keys: only where both ends live in the same database
  for (const f of m.fields) {
    const rel = f.attrs.relation;
    if (f.kind !== 'relation' || !rel || rel.fields.length === 0) continue;
    const target = sameDb.get(f.type);
    if (!target) continue;
    const tField = n => target.fields.find(x => x.name === n)?.column;
    const localOptional = rel.fields.some(n => fieldByName.get(n)?.optional);
    const onDelete = rel.onDelete ?? (localOptional ? 'SetNull' : 'Restrict');
    const action = {
      Cascade: 'CASCADE',
      SetNull: 'SET NULL',
      Restrict: 'RESTRICT',
      NoAction: 'NO ACTION',
      SetDefault: 'SET DEFAULT',
    }[onDelete];
    if (!action) throw new Error(`${m.name}.${f.name}: onDelete ${onDelete}`);
    fks.push({
      cols: rel.fields.map(colOf),
      refTable: target.dbName,
      refCols: rel.references.map(tField),
      action,
      // Prisma's default referential action on update is Cascade (a primary-key change reaches the children)
      onUpdate: {
        Cascade: 'CASCADE',
        SetNull: 'SET NULL',
        Restrict: 'RESTRICT',
        NoAction: 'NO ACTION',
        SetDefault: 'SET DEFAULT',
      }[rel.onUpdate ?? 'Cascade'],
    });
  }

  const idxName = (kind, cols) => `${table}_${cols.join('_')}_${kind}`;
  const fu = m.fields.filter(x => x.attrs.unique && x.kind !== 'relation');
  for (const f of fu)
    uniques.push({ name: idxName('key', [f.column]), cols: [f.column], desc: [false] });
  for (const u of m.uniques) {
    const cols = u.fields.map(x => colOf(x.field));
    uniques.push({ name: u.map ?? idxName('key', cols), cols, desc: u.fields.map(x => !!x.desc) });
  }
  for (const ix of m.indexes) {
    const cols = ix.fields.map(x => colOf(x.field));
    indexes.push({
      name: ix.map ?? idxName('idx', cols),
      cols,
      desc: ix.fields.map(x => !!x.desc),
    });
  }

  if (columns.length > MAX_COLUMNS)
    throw new Error(`${table} has ${columns.length} columns (limit ${MAX_COLUMNS})`);
  return {
    name: table,
    model: m.name,
    origin:
      ctx.target === 'store-do' && (m.name === 'StoreProfile' || m.name === 'StoreConfig')
        ? 'stores'
        : ctx.target === 'd1' && m.name === 'Store'
          ? 'stores'
          : table,
    columns,
    pk,
    fks,
    uniques,
    indexes,
    rawChecks: [],
    rawIndexes: [],
    note: m.note,
    appendOnly: m.appendOnly,
  };
}

// ---- emitters ------------------------------------------------------------------------------
function colSql(c, pkCols) {
  const single = pkCols.length === 1 && pkCols[0] === c.col;
  if (c.autoincrement && single) return `  ${qid(c.col)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  const parts = [`  ${qid(c.col)} ${c.sql}`];
  if (!c.optional) parts.push('NOT NULL');
  if (c.defaultSql !== undefined) parts.push(`DEFAULT ${c.defaultSql}`);
  return parts.join(' ');
}

/**
 * `migrations/platform/<n>_<name>.sql` for the columns declared `since: n` in cf-additions: ONE ALTER per column, with its
 * default and CHECK inline. 0001 is generated without them, so a fresh database gets each column exactly once.
 */
export function emitLateColumnsSql(db, since, title) {
  const lines = [
    `-- @generated by packages/cf-schema/scripts/generate.mjs from scripts/cf-additions.mjs (columns declared since: ${since}). Do not edit.`,
    `-- ${title}`,
    '-- @once: ALTER TABLE ADD COLUMN is not idempotent; the migration runner applies each numbered file exactly once.',
    '',
  ];
  for (const t of [...db.tables].sort((a, b) => a.name.localeCompare(b.name)))
    for (const c of t.columns.filter(x => x.since === since)) {
      const checks = c.checks
        .map(ck => ` CHECK (${c.optional ? `${qid(c.col)} IS NULL OR (${ck})` : ck})`)
        .join('');
      lines.push(`ALTER TABLE ${qid(t.name)} ADD COLUMN ${colSql(c, t.pk).trim()}${checks};`);
    }
  return lines.join('\n') + '\n';
}

export function emitSql(db, title) {
  const lines = [
    `-- @generated by packages/cf-schema/scripts/generate.mjs from packages/database/prisma/schema.prisma. Do not edit.`,
    `-- ${title}`,
    `-- ${db.tables.length} tables. Idempotent (IF NOT EXISTS).`,
    '',
  ];
  const names = new Set();
  const uniq = n => {
    if (names.has(n)) throw new Error(`duplicate index/constraint name ${n}`);
    names.add(n);
    return n;
  };
  const sorted = [...db.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of sorted) {
    if (t.note) lines.push(`-- ${t.note}`);
    const body = [];
    const autoPk = t.columns.some(c => c.autoincrement) && t.pk.length === 1;
    for (const c of t.columns) if (!c.since) body.push(colSql(c, t.pk));
    if (!autoPk)
      body.push(`  CONSTRAINT ${qid(`${t.name}_pkey`)} PRIMARY KEY (${t.pk.map(qid).join(', ')})`);
    t.fks.forEach((fk, i) => {
      body.push(
        `  CONSTRAINT ${qid(uniq(`${t.name}_${fk.cols.join('_')}_fkey`))} FOREIGN KEY (${fk.cols.map(qid).join(', ')}) REFERENCES ${qid(fk.refTable)} (${fk.refCols.map(qid).join(', ')}) ON DELETE ${fk.action} ON UPDATE ${fk.onUpdate}`
      );
    });
    for (const c of t.columns)
      for (const [i, ck] of c.checks.entries())
        if (!c.since)
          body.push(
            `  CONSTRAINT ${qid(uniq(`${t.name}_${c.col}_chk${i ? i : ''}`))} CHECK (${c.optional ? `${qid(c.col)} IS NULL OR (${ck})` : ck})`
          );
    for (const rc of t.rawChecks)
      body.push(`  CONSTRAINT ${qid(uniq(rc.name))} CHECK (${rc.expr})`);
    lines.push(`CREATE TABLE IF NOT EXISTS ${qid(t.name)} (`, body.join(',\n'), ');');
    for (const u of t.uniques)
      lines.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${qid(uniq(u.name))} ON ${qid(t.name)} (${u.cols.map((c, i) => qid(c) + (u.desc[i] ? ' DESC' : '')).join(', ')});`
      );
    for (const ix of t.indexes)
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${qid(uniq(ix.name))} ON ${qid(t.name)} (${ix.cols.map((c, i) => qid(c) + (ix.desc[i] ? ' DESC' : '')).join(', ')});`
      );
    for (const ix of t.rawIndexes)
      lines.push(
        `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qid(uniq(ix.name))} ON ${qid(t.name)} (${ix.cols})${ix.where ? ` WHERE ${ix.where}` : ''};`
      );
    lines.push('');
  }
  return lines.join('\n');
}

function tsColumn(c, pkSingle) {
  const { fn, mode, enumValues, json } = c.ts;
  const cfg = [];
  if (enumValues) cfg.push(`enum: [${enumValues.map(v => JSON.stringify(v)).join(', ')}]`);
  if (mode) cfg.push(`mode: '${mode}'`);
  if (json) cfg.push("mode: 'json'");
  let s = `${fn}('${c.col}'${cfg.length ? `, { ${cfg.join(', ')} }` : ''})`;
  if (json) s += `.$type<${json}>()`;
  if (pkSingle) s += c.autoincrement ? '.primaryKey({ autoIncrement: true })' : '.primaryKey()';
  if (!c.optional && !c.autoincrement) s += '.notNull()';
  if (c.appDefault) s += `.$defaultFn(() => ${c.appDefault})`;
  else if (c.tsDefault !== undefined) s += `.default(${JSON.stringify(c.tsDefault)})`;
  else if (c.defaultSql === NOW_SQL)
    s += ".default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`)";
  return s;
}

export function emitTs(db, which) {
  const used = new Set(['sqliteTable']);
  const body = [];
  const exportNames = new Set();
  const sorted = [...db.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of sorted) {
    const ident = camel(t.name);
    if (exportNames.has(ident)) throw new Error(`duplicate export ${ident}`);
    exportNames.add(ident);
    const cols = t.columns.map(c => {
      used.add(c.ts.fn);
      return `    ${c.prop}: ${tsColumn(c, t.pk.length === 1 && t.pk[0] === c.col)},`;
    });
    let extra = '';
    if (t.pk.length > 1) {
      used.add('primaryKey');
      extra = `, t => [primaryKey({ columns: [${t.pk.map(pc => `t.${t.columns.find(c => c.col === pc).prop}`).join(', ')}] })]`;
    }
    body.push(
      `export const ${ident} = sqliteTable('${t.name}', {\n${cols.join('\n')}\n}${extra});`
    );
  }
  const text = body.join('\n\n');
  const needSql = text.includes('sql`');
  const imports = [...used].sort();
  const header = `// @generated by packages/cf-schema/scripts/generate.mjs from packages/database/prisma/schema.prisma. Do not edit.
// Columns and primary keys only: the migration SQL (migrations/${which}/0001_init.sql) is the DDL source of truth
// (indexes, CHECK constraints, foreign keys). Property names are the Prisma field names; DateTime is epoch ms,
// Decimal is an integer scaled by 10^scale (generated/manifest.json lists them), Json is TEXT.
`;
  return `${header}import { ${imports.join(', ')} } from 'drizzle-orm/sqlite-core';\n${needSql ? "import { sql } from 'drizzle-orm';\n" : ''}\n${text}\n`;
}

/**
 * The StoreDO migrations as a TS module: the Worker bundle (wrangler, no `.sql` module rule) and the DO bootstrap
 * import this instead of reading the SQL files. 0001 is the generated DDL; 0002, 0004 and 0005 are hand-kept files.
 */
export function emitStoreMigrationsTs(
  initSql,
  invariantsSql,
  analyticsSql,
  templateCurrentSql,
  reorderRulesUniqueSql,
  templateExpandOnlySql,
  aiReplaceBackupsSql
) {
  return `// @generated by packages/cf-schema/scripts/generate.mjs from migrations/store/*.sql. Do not edit.
// The StoreDO applies these in order on start (apps/api/src/cf/store-do/migrations.ts); ids are what \`_migrations\` records.
export const STORE_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  { id: 'cf-0001_init', sql: ${JSON.stringify(initSql)} },
  { id: 'cf-0002_invariants', sql: ${JSON.stringify(invariantsSql)} },
  { id: 'cf-0003_analytics', sql: ${JSON.stringify(analyticsSql)} },
  { id: 'cf-0004_template_current', sql: ${JSON.stringify(templateCurrentSql)} },
  { id: 'cf-0005_reorder_rules_one_per_item', sql: ${JSON.stringify(reorderRulesUniqueSql)} },
  { id: 'cf-0006_template_expand_only', sql: ${JSON.stringify(templateExpandOnlySql)} },
  { id: 'cf-0008_ai_replace_backups', sql: ${JSON.stringify(aiReplaceBackupsSql)} },
];
`;
}

// Ruling NZ-AN-1: tables added to databases that already ran 0001 (a deployed StoreDO / D1 records 0001 as applied and never
// re-reads it). Same generated DDL as 0001 (idempotent IF NOT EXISTS), restricted to the tables each later migration owns.
const ANALYTICS_STORE_TABLES = [
  'search_query_daily',
  'product_daily_views',
  'qr_scan_daily',
  'notification_logs',
  'gsc_daily_metrics',
];
// Ruling AITOOLS-4: the AI replace undo history, added after 0001 went live (0007 is the parked template contract).
const AI_REPLACE_STORE_TABLES = ['ai_replace_backups'];
const ANALYTICS_PLATFORM_TABLES = ['ai_usage'];
// Ruling NZ-C-11: admin push devices (family ops), added after 0001 went live.
const ONESIGNAL_PLATFORM_TABLES = ['onesignal_subscriptions'];
// A13/A14/A16 trust requests, added after 0001 went live (a D1 that already ran 0001 never re-reads it).
const TRUST_PLATFORM_TABLES = ['trust_requests'];
const onlyTables = (db, names) => ({
  ...db,
  tables: db.tables.filter(t => names.includes(t.name)),
});

function main() {
  const check = process.argv.includes('--check');
  const { out, manifest } = build();
  const analyticsStoreSql = emitSql(
    onlyTables(out['store-do'], ANALYTICS_STORE_TABLES),
    'StoreDO analytics tables (Ruling NZ-AN-1), for StoreDOs that already ran 0001'
  );
  const aiReplaceStoreSql = emitSql(
    onlyTables(out['store-do'], AI_REPLACE_STORE_TABLES),
    'StoreDO ai_replace_backups (Ruling AITOOLS-4), for StoreDOs that already ran 0001'
  );
  const files = {
    'migrations/store/0001_init.sql': emitSql(
      out['store-do'],
      'StoreDO schema (one SQLite Durable Object per store)'
    ),
    'migrations/platform/0001_init.sql': emitSql(
      out.d1,
      'D1 ebda-platform schema (identity excluded: it lives in ebda-identity)'
    ),
    'src/store/schema.generated.ts': emitTs(out['store-do'], 'store'),
    'src/store/migrations.generated.ts': emitStoreMigrationsTs(
      emitSql(out['store-do'], 'StoreDO schema (one SQLite Durable Object per store)'),
      fs.readFileSync(path.join(pkg, 'migrations/store/0002_invariants.sql'), 'utf8'),
      analyticsStoreSql,
      // Ruling SKIN-DEL-9: hand-written, like 0002.
      fs.readFileSync(path.join(pkg, 'migrations/store/0004_template_current.sql'), 'utf8'),
      // M-107 follow-up: hand-written, like 0002.
      fs.readFileSync(
        path.join(pkg, 'migrations/store/0005_reorder_rules_one_per_item.sql'),
        'utf8'
      ),
      // Ruling SKIN-DEL-10: hand-written, drops the 0004 triggers (expand-only).
      fs.readFileSync(path.join(pkg, 'migrations/store/0006_template_expand_only.sql'), 'utf8'),
      aiReplaceStoreSql
    ),
    'migrations/store/0003_analytics.sql': analyticsStoreSql,
    'migrations/store/0008_ai_replace_backups.sql': aiReplaceStoreSql,
    'migrations/platform/0005_ai_usage.sql': emitSql(
      onlyTables(out.d1, ANALYTICS_PLATFORM_TABLES),
      'D1 ai_usage (Ruling NZ-AN-1), for a D1 that already ran 0001'
    ),
    'migrations/platform/0006_onesignal_subscriptions.sql': emitSql(
      onlyTables(out.d1, ONESIGNAL_PLATFORM_TABLES),
      'D1 onesignal_subscriptions (Ruling NZ-C-11), for a D1 that already ran 0001'
    ),
    'migrations/platform/0012_trust_requests.sql': emitSql(
      onlyTables(out.d1, TRUST_PLATFORM_TABLES),
      'D1 trust_requests (A13/A14/A16), for a D1 that already ran 0001'
    ),
    ...Object.fromEntries(
      Object.entries(LATE_COLUMN_MIGRATIONS).map(([n, name]) => [
        `migrations/platform/${String(n).padStart(4, '0')}_${name}.sql`,
        emitLateColumnsSql(
          out.d1,
          Number(n),
          `D1 ebda-platform: columns added after 0001 (migration ${n})`
        ),
      ])
    ),
    'src/platform/schema.generated.ts': emitTs(out.d1, 'platform'),
    'generated/manifest.json': JSON.stringify({ ...manifest, meta: undefined }, null, 2) + '\n',
    'generated/prisma-meta.json': JSON.stringify(manifest.meta, null, 1) + '\n',
  };
  // workerd refuses a LIKE/GLOB pattern longer than 50 bytes at EXECUTION time ("LIKE or GLOB pattern too
  // complex"), so an oversize CHECK only fails on a real Durable Object, never in node:sqlite. Fail here.
  const longPatterns = [];
  const scanPatterns = (label, text) => {
    for (const m of text.matchAll(/\b(?:NOT\s+)?(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi))
      if (Buffer.byteLength(m[1].replace(/''/g, "'")) > 50)
        longPatterns.push(`${label}: ${Buffer.byteLength(m[1])} bytes in ${m[0].slice(0, 90)}`);
  };
  for (const [rel, content] of Object.entries(files))
    if (rel.endsWith('.sql')) scanPatterns(rel, content);
  for (const dir of ['migrations/store', 'migrations/platform'])
    for (const f of fs.readdirSync(path.join(pkg, dir)))
      if (f.endsWith('.sql') && !(`${dir}/${f}` in files))
        scanPatterns(`${dir}/${f}`, fs.readFileSync(path.join(pkg, dir, f), 'utf8'));
  if (longPatterns.length)
    throw new Error(
      `LIKE/GLOB patterns over workerd's 50-byte limit:\n- ${longPatterns.join('\n- ')}`
    );
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(pkg, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (rel.endsWith('.ts') || rel.endsWith('.json'))
      execFileSync('npx', ['prettier', '--write', p], { cwd: repo, stdio: 'ignore' });
  }
  if (check) {
    // CI mode: the generator ran in place; any difference from the committed files means they were stale.
    try {
      execFileSync(
        'git',
        [
          'diff',
          '--exit-code',
          '--stat',
          '--',
          ...Object.keys(files).map(f => path.join('packages/cf-schema', f)),
        ],
        { cwd: repo, stdio: 'inherit' }
      );
    } catch {
      console.error(
        'STALE: run `node packages/cf-schema/scripts/generate.mjs` and commit the result'
      );
      process.exit(1);
    }
    console.log('cf-schema generated files are current');
    return;
  }
  const s = manifest.databases;
  console.log(
    `store-do: ${s['store-do'].tables} tables (max ${s['store-do'].maxColumns} columns); d1: ${s.d1.tables} tables (max ${s.d1.maxColumns} columns)`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
