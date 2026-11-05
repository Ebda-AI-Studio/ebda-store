// Restore drill (Ruling NZ-BACKUP-1): prove a backup can be turned back into a working store, not only that counts match.
// Pure orchestration over injected targets so the unit tests and the weekly fixture drill share it with the real drill.
import { fetchBackupSet, parseStoreDump, compareTables } from './cf-backup.mjs';

export const IMPORT_PAGE_ROWS = 1000;

/** The drill only ever writes to a loopback worker. A remote URL is a misuse, not an option. */
export function assertLoopback(url) {
  const h = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h))
    throw new Error(`refusing ${url}: the restore drill writes only to a local worker`);
}

/** Replay a store dump through the production __import path, then __verify it. `post(path, body, contentType)` -> parsed JSON. */
export async function restoreStoreOverHttp(post, storeId, dump, batch) {
  const base = `/cutover/stores/${storeId}`;
  for (const t of dump) {
    for (let page = 0, i = 0; i < t.rows.length; page++, i += IMPORT_PAGE_ROWS) {
      const head = JSON.stringify({ batch, table: t.table, page, columns: t.columns, pk: t.pk });
      const body =
        [head, ...t.rows.slice(i, i + IMPORT_PAGE_ROWS).map(r => JSON.stringify(r))].join('\n') +
        '\n';
      await post(`${base}/__import`, body, 'application/x-ndjson');
    }
  }
  const res = await post(
    `${base}/__verify`,
    JSON.stringify({
      fk: true,
      tables: dump.map(t => ({ table: t.table, columns: t.columns, pk: t.pk })),
    }),
    'application/json'
  );
  return { tables: res.tables, fk: res.fk };
}

const pick = (j, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), j);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

/**
 * Real public + admin calls against the booted API for one restored store. `http(method, path, {headers, body})` -> {status, json}.
 * Returns [{name, ok, detail}]. A store with no products in the backup skips the product-dependent checks (named, not hidden).
 */
export async function apiChecksForStore(http, { store, productCount }) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail });
  const host = store.domain || `${store.slug}.ebda.app`;
  const pub = { 'x-store-domain': host, 'x-store-id': store.id, 'cf-connecting-ip': '10.0.0.7' };

  const r = await http('GET', '/api/v1/public/store/resolve', { headers: pub });
  add(
    'store resolve by domain',
    r.status === 200 && pick(r.json, 'data.store.id', 'data.id') === store.id,
    `HTTP ${r.status}`
  );

  const c = await http('GET', '/api/v1/public/categories', { headers: pub });
  add('categories list', c.status === 200 && c.json?.success !== false, `HTTP ${c.status}`);

  const l = await http('GET', '/api/v1/public/products?limit=20', { headers: pub });
  const list = pick(l.json, 'data.products', 'data.items', 'data') ?? [];
  add(
    'products list',
    l.status === 200 && (productCount === 0 || (Array.isArray(list) && list.length > 0)),
    `HTTP ${l.status}, ${Array.isArray(list) ? list.length : '?'} rows`
  );

  if (productCount > 0 && Array.isArray(list) && list.length) {
    const first = list[0];
    const d = await http('GET', `/api/v1/public/products/${first.slug ?? first.id}`, {
      headers: pub,
    });
    const product = pick(d.json, 'data.product', 'data');
    add('product detail', d.status === 200 && product?.id === first.id, `HTTP ${d.status}`);
    const variant = (product?.variants ?? [])[0];
    const sid = `drill-${Date.now()}`;
    const body = {
      productId: first.id,
      quantity: 1,
      ...(variant ? { variantId: variant.id } : {}),
    };
    const add1 = await http('POST', `/api/v1/stores/${store.id}/cart/items`, {
      headers: { ...pub, 'x-session-id': sid },
      body,
    });
    const back = await http('GET', `/api/v1/stores/${store.id}/cart`, {
      headers: { ...pub, 'x-session-id': sid },
    });
    const items = pick(back.json, 'data.cart.items') ?? [];
    add(
      variant
        ? 'add variant to guest cart, read cart back'
        : 'add product to guest cart, read cart back',
      add1.status === 201 && Array.isArray(items) && items.length === 1,
      `add HTTP ${add1.status}, cart HTTP ${back.status}, ${items.length} item(s)`
    );
  } else {
    add(
      'product detail + cart',
      productCount === 0,
      productCount === 0
        ? 'SKIPPED: the backup holds no products for this store'
        : 'no product in the list'
    );
  }

  // Admin read. Merchant/staff tokens are ES256 from the identity service and the API checks them through the ACCOUNTS Service Binding
  // (JWKS + isRevoked on every request); a local worker has no such binding, so a test-minted token cannot be accepted (measured:
  // TOKEN_INVALID 401). Named as a limit rather than faked: the orders table itself is proven by the per-table content digest above.
  add(
    'admin orders list (test-minted token)',
    true,
    'SKIPPED: admin tokens need the ACCOUNTS binding, absent locally; orders content proven by digest'
  );
  return out;
}

/**
 * The drill. targets = {
 *   decrypt(buf), loadD1(sqlText) -> { tables, stores: [{id,slug,domain,owner_id}] },
 *   post(path, body, ctype) -> json,           // StoreDO admin surface of the LOCAL worker
 *   apiChecks?(store, productCount) -> checks[] // omitted for the CI fixture drill
 * }
 */
export async function runDrill({ io, targets, tier = 'daily', day, now = () => Date.now() }) {
  const checks = [];
  const t0 = now();
  const step = async (name, fn) => {
    const s = now();
    try {
      const r = await fn();
      checks.push({ name, ok: true, detail: '', ms: now() - s });
      return r;
    } catch (e) {
      checks.push({ name, ok: false, detail: String(e.message ?? e), ms: now() - s });
      return null;
    }
  };

  const set = await step('fetch + decrypt + decompress + sha256 against the manifest', () =>
    fetchBackupSet({ io, tier, day, decrypt: targets.decrypt })
  );
  if (!set) return finish(checks, t0, now, null);
  const { manifest, files } = set;

  const d1 = await step('restore D1 ebda-platform locally', async () =>
    targets.loadD1(files['d1-ebda-platform'].toString('utf8'))
  );
  if (d1) {
    const cmp = compareTables(manifest.artifacts['d1-ebda-platform'].tables, d1.tables);
    const bad = cmp.filter(c => !c.ok);
    checks.push({
      name: `D1: ${cmp.length - bad.length}/${cmp.length} tables equal (count + content digest)`,
      ok: bad.length === 0,
      detail: bad
        .slice(0, 5)
        .map(b => `${b.table} want ${b.want} got ${b.got}`)
        .join('; '),
      ms: 0,
    });
  }

  const byId = new Map((d1?.stores ?? []).map(s => [s.id, s]));
  const batch = `restore-drill-${manifest.day}`;
  for (const [name, entry] of Object.entries(manifest.artifacts)) {
    if (!name.startsWith('do-')) continue;
    const id = name.slice(3);
    const dump = parseStoreDump(files[name].toString('utf8'));
    const res = await step(`store ${id}: replay ${dump.length} tables through __import`, () =>
      restoreStoreOverHttp(targets.post, id, dump, batch)
    );
    if (!res) continue;
    const cmp = compareTables(entry.tables, res.tables);
    const bad = cmp.filter(c => !c.ok);
    checks.push({
      name: `store ${id}: ${cmp.length - bad.length}/${cmp.length} tables equal (count + content digest)`,
      ok: bad.length === 0,
      detail: bad
        .slice(0, 5)
        .map(b => `${b.table} want ${b.want} got ${b.got}`)
        .join('; '),
      ms: 0,
    });
    checks.push({
      name: `store ${id}: foreign-key violations`,
      ok: (res.fk?.violations ?? 0) === 0,
      detail: JSON.stringify(res.fk?.sample ?? []),
      ms: 0,
    });
    if (targets.apiChecks) {
      const store = byId.get(id);
      if (!store)
        checks.push({
          name: `store ${id}: public + admin API checks`,
          ok: false,
          detail: 'store row missing from the restored D1',
          ms: 0,
        });
      else {
        const products = entry.tables.products?.count ?? 0;
        for (const c of await targets.apiChecks(store, products))
          checks.push({ ...c, name: `store ${id}: ${c.name}`, ms: 0 });
      }
    }
  }
  return finish(checks, t0, now, manifest);
}

function finish(checks, t0, now, manifest) {
  return { pass: checks.every(c => c.ok), checks, totalMs: now() - t0, day: manifest?.day ?? null };
}

export function formatReport(rep) {
  const lines = rep.checks.map(
    c =>
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}${c.ms ? ` [${c.ms} ms]` : ''}`
  );
  lines.push(
    '',
    `${rep.pass ? 'DRILL PASS' : 'DRILL FAIL'}  backup day ${rep.day ?? '?'}  total ${(rep.totalMs / 1000).toFixed(1)} s`
  );
  return lines.join('\n');
}
