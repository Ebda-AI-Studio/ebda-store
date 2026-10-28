// Rollback replay (Audit DB-1): rows the live Cloudflare side changed after the flip are written back into
// Postgres, in ONE transaction the caller commits only once source and target digests are equal.
import { scopeWhere } from './plan.mjs';

const q = s => `"${s}"`;

export async function pgTypes(client) {
  const r = await client.query(
    `SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const m = new Map();
  for (const x of r.rows) m.set(`${x.table_name}.${x.column_name}`, x);
  return m;
}

/** SQL expression turning the wire value in placeholder `ph` back into the Postgres column type */
export function castBack(kind, scale, type, ph) {
  const udt = q(type.udt_name);
  switch (kind) {
    case 'bool':
      return `(${ph}::int = 1)`;
    case 'date':
      return type.data_type === 'timestamp with time zone'
        ? `to_timestamp(${ph}::double precision / 1000)`
        : `(to_timestamp(${ph}::double precision / 1000) AT TIME ZONE 'UTC')`;
    case 'decimal':
      return `(${ph}::numeric / ${10n ** BigInt(scale)})`;
    case 'float':
      return `${ph}::float8`;
    case 'list':
      return `CASE WHEN ${ph}::text IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${ph}::jsonb))::${udt} END`;
    default:
      return `${ph}::${udt}`;
  }
}

/** a store-ownership violation: the whole replay transaction must abort */
export class ReplayOwnershipError extends Error {}

/**
 * One table's share of a diff (DO `__diff` shape). phase 'upsert' runs parents first, then phase 'delete'
 * runs children first (the caller orders the tables).
 *
 * The rollback runs with owner privileges (no RLS), so every write is fenced to the store it belongs to:
 *  - before writing, the row's own store key must be the store being replayed (DO scope: ctx.storeId; D1
 *    scope: a store in ctx.allowed);
 *  - UPDATE / ON CONFLICT DO UPDATE / DELETE carry the same ownership predicate the migration read with
 *    (scopeWhere), so a row that exists in Postgres under ANOTHER store is never touched;
 *  - each write must affect exactly 1 row, and an upserted row must read back as owned by the store;
 *  - anything else throws ReplayOwnershipError (the caller rolls the transaction back).
 * @param ctx { storeId: string|null, allowed: Set<string>, all: unbound plan tables of this scope }
 */
export async function replayTable(client, types, bt, d, phase, ctx) {
  // the fence must be configured explicitly (storeId null = D1 scope); a missing ctx must never mean "no fence"
  if (!ctx || ctx.storeId === undefined || !(ctx.allowed instanceof Set) || !Array.isArray(ctx.all))
    throw new ReplayOwnershipError(`${bt.name}: replay called without a store fence`);
  const n = { table: bt.name, upserted: 0, deleted: 0, skippedCols: [] };
  const wanted = bt.columns.filter(c => d.columns.includes(c.col));
  n.skippedCols = d.columns.filter(c => !bt.columns.some(b => b.col === c));
  const idx = new Map(d.columns.map((c, i) => [c, i]));
  const isSplit = bt.origin === 'stores' && bt.name !== 'stores';
  const target = bt.origin;
  const type = c => {
    const t = types.get(`${target}.${c.src}`);
    if (!t) throw new Error(`no Postgres column ${target}.${c.src}`);
    return t;
  };
  const pkCols = bt.pk.map(k => bt.columns.find(c => c.col === k));
  const storeCol = d.columns.indexOf('store_id');
  const idCol = d.columns.indexOf('id');
  // a table keyed by store (a store_id column, or the stores table itself): its rows MUST name an allowed store
  const storeScoped = target === 'stores' || bt.columns.some(c => c.col === 'store_id');
  const fail = msg => {
    throw new ReplayOwnershipError(`${bt.name}: ${msg}`);
  };

  /** the store a diff row claims, checked against the store(s) being replayed */
  const claimedStore = (row, pkValues) => {
    let claimed = null;
    if (storeCol >= 0) claimed = row ? row[storeCol] : null;
    else if (target === 'stores') claimed = pkValues[0];
    if (row && storeScoped && (claimed === null || claimed === undefined || claimed === ''))
      fail('a row of a store-scoped table carries a NULL store claim');
    if (ctx.storeId) {
      if (claimed !== null && claimed !== ctx.storeId)
        fail(`a row claims store ${claimed} but store ${ctx.storeId} is being replayed`);
      return ctx.storeId;
    }
    if (claimed !== null && !ctx.allowed.has(String(claimed)))
      fail(`a row claims store ${claimed}, which is not one of the stores being rolled back`);
    return claimed === null ? null : String(claimed);
  };
  /** ownership predicate on the Postgres target for store `sid`, with $<slot> as the store id parameter */
  const owned = (sid, slot) =>
    sid === null ? null : scopeWhere(bt, ctx.all, q(target)).replace(/\$1\b/g, `$${slot}`);

  for (const row of phase === 'upsert' ? [...d.added, ...d.changed] : []) {
    // wire values are already null | string | number: the Postgres side casts them back (castBack)
    const vals = wanted.map(c => row[idx.get(c.col)] ?? null);
    const pkVals = pkCols.map(c => row[idx.get(c.col)]);
    const sid = claimedStore(row, pkVals);
    const ph = i => `$${i + 1}`;
    const exprs = wanted.map((c, i) => castBack(c.kind, c.scale, type(c), ph(i)));
    const nonPk = wanted.filter(c => !bt.pk.includes(c.col));
    const slot = wanted.length + 1;
    const own = owned(sid, slot);
    const params = own ? [...vals, sid] : vals;
    const pkWhere = pkCols.map(c => `${q(c.src)} = ${exprs[wanted.indexOf(c)]}`).join(' AND ');
    if (isSplit) {
      // store_profile / store_config: the single row of Postgres stores, keyed by id
      if (!nonPk.length) continue;
      const set = nonPk.map(c => `${q(c.src)} = ${exprs[wanted.indexOf(c)]}`).join(', ');
      const r = await client.query(
        `UPDATE ${q(target)} SET ${set} WHERE ${pkWhere}${own ? ` AND ${own}` : ''}`,
        params
      );
      if (r.rowCount !== 1) fail(`expected to update exactly 1 stores row, updated ${r.rowCount}`);
    } else {
      const upd = nonPk.length
        ? `DO UPDATE SET ${nonPk.map(c => `${q(c.src)} = EXCLUDED.${q(c.src)}`).join(', ')}${own ? ` WHERE ${own}` : ''}`
        : 'DO NOTHING';
      const r = await client.query(
        `INSERT INTO ${q(target)} (${wanted.map(c => q(c.src)).join(', ')}) VALUES (${exprs.join(', ')}) ON CONFLICT (${pkCols.map(c => q(c.src)).join(', ')}) ${upd}`,
        nonPk.length ? params : vals // DO NOTHING has no predicate to bind the store id to
      );
      if (r.rowCount !== 1)
        fail(
          `expected exactly 1 row written, got ${r.rowCount} (an existing row under another store, or an unchanged row, is never overwritten)`
        );
    }
    if (own) {
      // read-back binds ONLY the key and the store id (an unreferenced parameter has no type in Postgres)
      const keyWhere = pkCols
        .map((c, i) => `${q(c.src)} = ${castBack(c.kind, c.scale, type(c), `$${i + 1}`)}`)
        .join(' AND ');
      const back = await client.query(
        `SELECT 1 FROM ${q(target)} WHERE ${keyWhere} AND ${owned(sid, pkCols.length + 1)}`,
        [...pkVals, sid]
      );
      if (back.rowCount !== 1)
        fail('the written row does not read back as owned by the store being replayed');
    }
    n.upserted++;
  }
  if (phase === 'delete' && isSplit && d.deleted.length)
    fail('a store row was deleted on the live side; not replayable');
  for (const key of phase === 'delete' ? d.deleted : []) {
    const where = pkCols
      .map((c, i) => `${q(c.src)} = $${i + 1}::${q(type(c).udt_name)}`)
      .join(' AND ');
    let r;
    if (storeScoped) {
      // The key alone proves nothing about ownership: read the row's REAL store inside the transaction,
      // require it to be an allowed store, and bind the delete to the allowed store list.
      const col = target === 'stores' ? 'id' : 'store_id';
      const owner = await client.query(
        `SELECT ${q(col)}::text AS store FROM ${q(target)} WHERE ${where}`,
        key
      );
      if (owner.rowCount !== 1) fail(`expected exactly 1 row to delete, found ${owner.rowCount}`);
      const store = owner.rows[0].store;
      if (store === null || store === undefined || store === '')
        fail('the row to delete carries a NULL store claim');
      if (!ctx.allowed.has(store))
        fail(`the row to delete belongs to store ${store}, which is not being rolled back`);
      if (ctx.storeId && store !== ctx.storeId)
        fail(
          `the row to delete belongs to store ${store} but store ${ctx.storeId} is being replayed`
        );
      const allowed = ctx.storeId ? [ctx.storeId] : [...ctx.allowed];
      r = await client.query(
        `DELETE FROM ${q(target)} WHERE ${where} AND ${q(col)}::text = ANY($${pkCols.length + 1}::text[])`,
        [...key, allowed]
      );
    } else {
      // no store key (a child table in DO scope): fenced through its parent chain
      const sid = claimedStore(null, key);
      const own = owned(sid, pkCols.length + 1);
      r = await client.query(
        `DELETE FROM ${q(target)} WHERE ${where}${own ? ` AND ${own}` : ''}`,
        own ? [...key, sid] : key
      );
    }
    if (r.rowCount !== 1) fail(`expected to delete exactly 1 row, deleted ${r.rowCount}`);
    n.deleted += r.rowCount;
  }
  return n;
}
