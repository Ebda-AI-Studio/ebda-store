#!/usr/bin/env node
// SP4 done-when over HTTP: the Amelia Aurum catalogue is served at its host, a rival / unknown host is not.
//   node scripts/ebda-amelia-http-check.mjs --api http://127.0.0.1:4816/api/v1 [--json out.json]
// Exit 0 when every check holds. Prints one summary line per request.
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const API = opt('--api', 'http://127.0.0.1:4000/api/v1');
const out = [];
let failed = 0;
async function get(label, path, host, check) {
  const t = Date.now();
  const res = await fetch(`${API}${path}`, { headers: host ? { 'x-store-domain': host } : {} });
  const body = await res.json().catch(() => null);
  const ms = Date.now() - t;
  const { ok, note } = check(res.status, body);
  if (!ok) failed++;
  const row = { label, host, path, status: res.status, ms, ok, note };
  out.push(row);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${res.status} ${ms}ms  GET ${path}  host=${host ?? '-'}  ${label}: ${note}`
  );
  return body;
}
const egp = p => (p / 100).toFixed(2);
const list = await get(
  'amelia catalogue',
  '/public/products?limit=50',
  'amelia.ebda.app',
  (s, b) => {
    const ps = b?.data?.products ?? b?.data ?? [];
    const prices = ps.map(p => p.price);
    const ok =
      s === 200 && ps.length === 12 && prices.every(Number.isInteger) && prices.every(p => p > 0);
    return {
      ok,
      note: `${ps.length} products (meta.total ${b?.meta?.total}); piastres ${Math.min(...prices)}..${Math.max(...prices)} = EGP ${egp(Math.min(...prices))}..${egp(Math.max(...prices))}`,
    };
  }
);
const products = list?.data?.products ?? list?.data ?? [];
const sample = products.find(p => p.slug === 'solitaire-ring-18k');
await get('amelia store currency', '/public/stores/amelia', 'amelia.ebda.app', (s, b) => ({
  ok:
    s === 200 && b?.data?.store?.currency === 'EGP' && b?.data?.store?.timezone === 'Africa/Cairo',
  note: `currency ${b?.data?.store?.currency}, timezone ${b?.data?.store?.timezone}`,
}));
await get(
  'amelia product detail',
  '/public/products/solitaire-ring-18k',
  'amelia.ebda.app',
  (s, b) => {
    const p = b?.data?.product ?? b?.data;
    const v = p?.variants ?? [];
    return {
      ok: s === 200 && p?.price === 1875000 && v.length === 4,
      note: `${p?.name} price ${p?.price} piastres (EGP ${egp(p?.price)}), ${v.length} variants ${v.map(x => x.price).join('/')}`,
    };
  }
);
await get('rival host list', '/public/products?limit=50', 'rival.ebda.app', (s, b) => {
  const ps = b?.data?.products ?? b?.data ?? [];
  return {
    ok: [200, 400, 404].includes(s) && ps.length === 0,
    note: `status ${s} ${b?.error?.code ?? ''}, ${ps.length} products (must be none)`,
  };
});
await get(
  "rival host asks for amelia's product",
  '/public/products/solitaire-ring-18k',
  'rival.ebda.app',
  (s, b) => ({
    ok: (s === 404 || s === 400) && !b?.data,
    note: `expected a refusal (404, or 400 STORE_NOT_RESOLVED for a host with no store), got ${s} ${b?.error?.code ?? ''}`,
  })
);
await get('unknown host list', '/public/products?limit=50', 'nope-unknown.ebda.app', (s, b) => {
  const ps = b?.data?.products ?? b?.data ?? [];
  return {
    ok: [400, 404].includes(s) || ps.length === 0,
    note: `status ${s}, ${ps.length} products ${b?.error?.code ?? ''}`,
  };
});
await get('no host header', '/public/products?limit=50', null, (s, b) => {
  const ps = b?.data?.products ?? b?.data ?? [];
  return {
    ok: ps.length === 0,
    note: `status ${s}, ${ps.length} products ${b?.error?.code ?? ''}`,
  };
});
const jp = opt('--json');
if (jp) (await import('node:fs')).writeFileSync(jp, JSON.stringify(out, null, 2));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
