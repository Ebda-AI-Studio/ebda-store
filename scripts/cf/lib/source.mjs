import {
  RULED_DROPPED_COLUMNS,
  RULED_UNMIGRATED_TABLES,
  bindTable,
  coveredColumns,
  scopeWhere,
  tableQuery,
  transformValue,
} from './plan.mjs';
import { cursorPages, pgColumns } from './pg.mjs';
import { pgSourcedTables } from '../../../packages/cf-migrate/src/coverage.mjs';
import { TableDigest } from '../../../packages/cf-migrate/src/canon.mjs';

/** plan tables that exist in Postgres, bound to the real columns; `skipped` = Cloudflare-only tables */
export async function bindPlan(client, plan) {
  const cols = await pgColumns(client);
  const covered = coveredColumns(plan);
  const bind = list => ({
    tables: list.filter(t => t.inPg).map(t => bindTable(t, cols, covered)),
    cfOnly: list.filter(t => !t.inPg).map(t => t.name),
  });
  // DO tables sourced from part of a Postgres table (instapay_order_receipts, Ruling CF-R6A-4)
  const extra = pgSourcedTables().map(t => {
    const have = cols.get(t.origin);
    if (!have) throw new Error(`table ${t.origin} is not in Postgres`);
    for (const c of t.columns)
      if (!have.has(c.src)) throw new Error(`${t.name}.${c.col}: Postgres has no column ${c.src}`);
    const dropped = [...have].filter(
      n => !t.columns.some(c => c.src === n) && !t.ignored.includes(n)
    );
    if (dropped.length)
      throw new Error(
        `${t.origin} gained column(s) ${dropped.join(', ')} that ${t.name} does not carry: map or ignore them in PG_SOURCED_DO_TABLES`
      );
    return { ...t, dropped: [], missingExtra: [] };
  });
  return { store: bind(plan.store), platform: bind(plan.platform), extra, cols };
}

/** async generator of { rows } pages, rows already transformed (aligned with bt.columns) */
export async function* sourcePages(client, bt, allUnbound, scope, storeId, pageSize = 1000) {
  const sqlText = tableQuery(bt, allUnbound, scope);
  const params = scope === 'store' ? [storeId] : [];
  for await (const raw of cursorPages(client, sqlText, params, pageSize)) {
    yield raw.map(r =>
      bt.columns.map(c => transformValue(c.kind, r[c.col], `${bt.name}.${c.col}`))
    );
  }
}

/** { count, digest } of the Postgres side of a table, through the same transform the import uses */
export async function sourceDigest(client, bt, allUnbound, scope, storeId) {
  const d = new TableDigest();
  const names = bt.columns.map(c => c.col);
  for await (const rows of sourcePages(client, bt, allUnbound, scope, storeId, 2000))
    for (const r of rows) await d.add(names, r, bt.pk);
  return d.finish();
}

/**
 * Non-null values in Postgres columns the Cloudflare schema does not carry. Ruled columns (legacy WBS
 * bridge) are counted but allowed; anything else is reported as loss and stops the run.
 */
export async function droppedColumnLoss(client, bt, allUnbound, scope, storeId) {
  const out = [];
  const where = scope === 'store' ? ` WHERE ${scopeWhere(bt, allUnbound)}` : '';
  for (const col of bt.dropped) {
    const key = `${bt.origin}.${col}`;
    const r = await client.query(
      `SELECT count(*) FILTER (WHERE t."${col}" IS NOT NULL) AS n FROM "${bt.origin}" t${where}`,
      scope === 'store' ? [storeId] : []
    );
    const nonNull = Number(r.rows[0].n);
    if (nonNull > 0)
      out.push({ table: bt.origin, column: col, nonNull, ruled: RULED_DROPPED_COLUMNS.has(key) });
  }
  return out;
}

/** public tables no plan table reads and no ruling excuses: they must be empty or the run stops */
export async function unmigratedTables(client, plan) {
  const read = new Set([...plan.store, ...plan.platform].map(t => t.origin));
  const r = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return r.rows.map(x => x.table_name).filter(n => !read.has(n));
}

/**
 * Independent semantic aggregates, computed in Postgres with DIFFERENT expressions than the transform
 * (sum of the raw numeric * 10^scale, sum of raw epoch seconds * 1000, sum of booleans, sum of array
 * cardinalities). Returns [{col, op, expr}] for the columns worth cross-checking.
 */
export function aggSpecs(bt) {
  const out = [];
  for (const c of bt.columns) {
    const ref = `t."${c.src}"`;
    if (c.kind === 'decimal')
      out.push({
        col: c.col,
        op: 'sum',
        expr: `round(sum(${ref}) * ${10n ** BigInt(c.scale)})::bigint::text`,
      });
    else if (c.kind === 'date')
      out.push({
        col: c.col,
        op: 'sum',
        expr: `round(sum(extract(epoch from ${ref})) * 1000)::bigint::text`,
      });
    else if (c.kind === 'bool')
      out.push({ col: c.col, op: 'sum', expr: `sum((${ref})::int)::bigint::text` });
    else if (c.kind === 'list')
      out.push({ col: c.col, op: 'sum_json_len', expr: `sum(cardinality(${ref}))::bigint::text` });
  }
  return out;
}

export async function sourceAggs(client, bt, allUnbound, scope, storeId) {
  const specs = aggSpecs(bt);
  if (!specs.length) return { specs, values: {} };
  const where = scope === 'store' ? ` WHERE ${scopeWhere(bt, allUnbound)}` : '';
  const r = await client.query(
    `SELECT ${specs.map((s, i) => `${s.expr} AS a${i}`).join(', ')} FROM "${bt.origin}" t${where}`,
    scope === 'store' ? [storeId] : []
  );
  return { specs, values: Object.fromEntries(specs.map((s, i) => [s.col, r.rows[0][`a${i}`]])) };
}
