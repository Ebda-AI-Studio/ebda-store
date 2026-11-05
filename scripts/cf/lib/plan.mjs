// The migration plan, derived from the SAME generator that emitted the Cloudflare schema
// (packages/cf-schema/scripts/generate.mjs build()), so a new Prisma column is migrated the moment the
// schema is regenerated and there is no second table list to keep in sync.
import { build } from '../../../packages/cf-schema/scripts/generate.mjs';

/** entity_index kinds that exist as tables (D1 entity_index, plan task 3.5) */
export const ENTITY_KIND_TABLES = {
  order: 'orders',
  payment: 'payments',
  shipment: 'shipments',
  customer: 'customers',
  return: 'returns',
};

const q = s => `"${s}"`;

function kindOf(c) {
  if (c.ts?.mode === 'boolean') return 'bool';
  if (c.ts?.mode === 'timestamp_ms') return 'date';
  if (c.decimalScale !== undefined) return 'decimal';
  if (c.ts?.json === 'string[]') return 'list';
  if (c.ts?.json === 'unknown') return 'json';
  if (c.ts?.fn === 'integer') return 'int';
  if (c.ts?.fn === 'real') return 'float';
  return 'text';
}

/** Postgres expression -> the exact value the SQLite column stores (all as text/number, no driver magic). */
export function selectExpr(kind, scale, ref) {
  switch (kind) {
    case 'bool':
      return `(${ref})::int`;
    case 'date': // timestamp(3) and timestamptz alike: epoch milliseconds, UTC
      return `round(extract(epoch from ${ref}) * 1000)::bigint::text`;
    case 'decimal': // exact: numeric * 10^scale, never through a float
      return `round(${ref} * ${10n ** BigInt(scale)})::bigint::text`;
    case 'int':
      return `(${ref})::text`;
    case 'float':
      return `(${ref})::float8`;
    case 'json':
      return `(${ref})::text`;
    case 'list': // text[] -> JSON array text
      return `to_json(${ref})::text`;
    default:
      return `(${ref})::text`;
  }
}

/** value from the pg driver -> value sent over the wire (and hashed). */
export function transformValue(kind, v, where = '') {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'bool':
      return Number(v);
    case 'date':
    case 'decimal':
    case 'int': {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new Error(`${where}: ${v} is not a safe integer`);
      return n;
    }
    case 'float': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${where}: non-finite float ${v}`);
      return n;
    }
    default:
      return String(v);
  }
}

export function loadPlan() {
  const { out, schema, split } = build();
  const pgTables = new Set(schema.models.map(m => m.dbName));
  const mk = (db, t) => ({
    db,
    name: t.name,
    origin: t.origin ?? t.name,
    pk: t.pk,
    fks: t.fks,
    inPg: pgTables.has(t.origin ?? t.name),
    columns: t.columns.map(c => ({
      col: c.col,
      // store_profile / store_config key their single row by store_id, which is stores.id in Postgres
      src:
        db === 'store-do' && (t.origin ?? t.name) === 'stores' && c.col === 'store_id'
          ? 'id'
          : c.col,
      kind: kindOf(c),
      scale: c.decimalScale,
      extra: !!c.note,
      optional: c.optional,
      hasDefault: c.defaultSql !== undefined || c.autoincrement,
    })),
  });
  const order = tables => {
    const by = new Map(tables.map(t => [t.name, t]));
    const seen = new Set();
    const res = [];
    const visit = t => {
      if (seen.has(t.name)) return;
      seen.add(t.name);
      for (const fk of t.fks)
        if (by.has(fk.refTable) && fk.refTable !== t.name) visit(by.get(fk.refTable));
      res.push(t);
    };
    [...tables].sort((a, b) => a.name.localeCompare(b.name)).forEach(visit);
    return res;
  };
  const store = order(out['store-do'].tables.map(t => mk('store-do', t)));
  const platform = order(out.d1.tables.map(t => mk('d1', t)));
  // models that live elsewhere by design: identity (ebda-identity D1, already moved), analytics (Analytics
  // Engine / Vectorize, rebuilt or archived), drop (Sentry + alarm)
  const elsewhere = new Map(
    schema.models
      .filter(m => ['identity', 'analytics', 'drop'].includes(split[m.name].target))
      .map(m => [m.dbName, split[m.name].target])
  );
  return { store, platform, elsewhere };
}

/**
 * Narrow a plan table to what Postgres really has. A column the plan wants but Postgres lacks must be a
 * documented Cloudflare-only addition (cf-additions); anything else is schema drift and stops the run.
 */
export function bindTable(t, pgCols, covered = new Set()) {
  const have = pgCols.get(t.origin);
  if (!have) throw new Error(`table ${t.origin} is not in Postgres`);
  const columns = [];
  const missingExtra = [];
  for (const c of t.columns) {
    if (have.has(c.src)) columns.push(c);
    else if (c.extra) missingExtra.push(c.col);
    else
      throw new Error(
        `${t.name}.${c.col}: Postgres has no column ${c.src} and it is not a documented Cloudflare-only addition (regenerate cf-schema or fix the drift)`
      );
  }
  // dropped = Postgres columns no emitted table carries (Store is split across three tables: a column
  // covered by a sibling is not dropped)
  const dropped = [...have].filter(
    n => !t.columns.some(c => c.src === n) && !covered.has(`${t.origin}.${n}`)
  );
  return { ...t, columns, missingExtra, dropped };
}

/**
 * Tables the Cloudflare schema keeps per store although Postgres hangs them off a USER, not a store
 * (no store_id, no foreign-key path). A row belongs to a store when its user is a customer, a staff member
 * or the owner of that store. Rows matching no store are reported as UNPLACED by the migrate script.
 */
export const USER_SCOPED = {
  addresses: 'user_id',
};
export const userScopeWhere = (alias, col = 'user_id') =>
  `(EXISTS (SELECT 1 FROM customers uc WHERE uc.user_id = ${alias}.${q(col)} AND uc.store_id = $1)` +
  ` OR EXISTS (SELECT 1 FROM store_staff us WHERE us.user_id = ${alias}.${q(col)} AND us.store_id = $1)` +
  ` OR EXISTS (SELECT 1 FROM stores uo WHERE uo.owner_id = ${alias}.${q(col)} AND uo.id = $1))`;

const tableByName = (all, n) => all.find(x => x.name === n);

/** a SQL boolean restricting `alias` rows of table t to one store ($1 = store id) */
export function scopeWhere(t, all, alias = 't', depth = 0) {
  if (t.origin === 'stores') return `${alias}.id = $1`;
  // a DO table fed from PART of a Postgres table (instapay_order_receipts: the kind = 'order' rows) narrows by its own filter
  if (t.columns.some(c => c.col === 'store_id'))
    return `${alias}.store_id = $1${t.filter ? ` AND ${t.filter(alias)}` : ''}`;
  if (USER_SCOPED[t.name]) return userScopeWhere(alias, USER_SCOPED[t.name]);
  if (depth > 4) throw new Error(`${t.name}: cannot reach a store_id`);
  for (const fk of t.fks) {
    const p = tableByName(all, fk.refTable);
    if (!p || fk.cols.length !== 1) continue;
    try {
      const pa = `p${depth}`;
      return `EXISTS (SELECT 1 FROM ${q(p.origin)} ${pa} WHERE ${pa}.${q(fk.refCols[0])} = ${alias}.${q(fk.cols[0])} AND ${scopeWhere(p, all, pa, depth + 1)})`;
    } catch {
      /* try the next foreign key */
    }
  }
  throw new Error(`${t.name}: no store_id and no foreign-key path to one`);
}

/** scalar SQL for the store id of a row (entity_index backfill) */
export function storeIdExpr(t, all, alias = 't', depth = 0) {
  if (t.columns.some(c => c.col === 'store_id')) return `${alias}.store_id`;
  if (depth > 4) throw new Error(`${t.name}: cannot reach a store_id`);
  for (const fk of t.fks) {
    const p = tableByName(all, fk.refTable);
    if (!p || fk.cols.length !== 1) continue;
    try {
      const pa = `p${depth}`;
      return `(SELECT ${storeIdExpr(p, all, pa, depth + 1)} FROM ${q(p.origin)} ${pa} WHERE ${pa}.${q(fk.refCols[0])} = ${alias}.${q(fk.cols[0])})`;
    } catch {
      /* next */
    }
  }
  throw new Error(`${t.name}: no path to a store id`);
}

/** The query for one bound table. `scope`: 'store' ($1 = store id) or 'all'. */
export function tableQuery(t, all, scope) {
  const cols = t.columns.map(c => `${selectExpr(c.kind, c.scale, `t.${q(c.src)}`)} AS ${q(c.col)}`);
  const where = scope === 'store' ? ` WHERE ${scopeWhere(t, all)}` : '';
  const order = t.pk.map(k => `t.${q(t.columns.find(c => c.col === k).src)}`).join(', ');
  return `SELECT ${cols.join(', ')} FROM ${q(t.origin)} t${where} ORDER BY ${order}`;
}

/** entity_index rows derived from Postgres (kind, id, store_id), one query per kind */
export function entityIndexQuery(kind, table, all) {
  const t = tableByName(all, table);
  if (!t) throw new Error(`entity kind ${kind}: no table ${table}`);
  const idSrc = t.columns.find(c => c.col === 'id').src;
  return `SELECT '${kind}'::text AS kind, t.${q(idSrc)}::text AS id, (${storeIdExpr(t, all)})::text AS store_id FROM ${q(t.origin)} t`;
}

/** every `origin.src` pair carried by any emitted table (both databases) */
export function coveredColumns(plan) {
  const s = new Set();
  for (const t of [...plan.store, ...plan.platform])
    for (const c of t.columns) s.add(`${t.origin}.${c.src}`);
  return s;
}

/**
 * Postgres columns/tables the Cloudflare schema deliberately does not carry. Anything else that holds
 * data fails the migration. Ruling: the legacy WBS WhatsApp bridge was deleted in #220/#223 (the Ebda
 * WhatsApp contract replaces it); its columns hold only default values or secrets of a bridge that is gone.
 */
export const RULED_DROPPED_COLUMNS = new Set([
  'stores.wbs_enabled',
  'stores.wbs_client_id',
  'stores.wbs_templates',
  'stores.wbs_template_use_logo_header',
  'stores.wa_customer_ordering_enabled',
  'stores.bot_copy',
  'stores.bot_mode',
  'stores.bot_service_menu',
  'stores.meta_catalog_id',
  'stores.meta_business_id',
  'store_credentials.wbs_api_key',
  'store_credentials.meta_access_token',
]);
export const RULED_UNMIGRATED_TABLES = new Set(['whatsapp_templates', '_prisma_migrations']);
