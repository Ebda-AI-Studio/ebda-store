#!/usr/bin/env node
// One-off (#1998, owner decision 2026-09-30): keep ONE store's sale badge in
// its legacy bottom-left corner by setting `StoreTheme.saleBadgeLegacyCorner`
// to true. Per-store DATA — the storefront code never branches on a slug.
//
// It goes through the real API, `PUT /api/v1/stores/:id/theme`, not raw SQL:
//   - that route is a server-side SHALLOW MERGE ({ ...existingTheme, ...body })
//     and its schema is `z.record(z.string(), z.unknown())`, so it accepts and
//     preserves a key the running code does not know yet. That is what makes it
//     safe to run BEFORE the #1998 code deploys;
//   - it busts the store caches (StoreService.invalidateCache +
//     bustStoreCaches), so no cached store payload without the key survives.
//
// Usage (dry run is the default and writes nothing):
//   FWB_ADMIN_TOKEN=<access JWT> node scripts/set-sale-badge-legacy-corner.mjs \
//     --api https://api.force-ai.co --store pecannbee
//   ... same command with --apply to write.
//
// FWB_ADMIN_TOKEN: a store_admin/super_admin access token for that store
// (the 30-minute JWT the admin uses; MFA-enrolled account). It is only ever
// sent to --api, in the Authorization header, and never printed.
//
// Exit codes: 0 done / nothing to do · 1 verification failed · 2 bad usage or
// request error.

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const API = (arg('--api') ?? '').replace(/\/+$/, '');
const STORE = arg('--store');
const TOKEN = process.env.FWB_ADMIN_TOKEN;
const KEY = 'saleBadgeLegacyCorner';

function die(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

if (!API || !/^https?:\/\//.test(API))
  die('--api <base url> is required, e.g. https://api.force-ai.co');
if (!STORE) die('--store <store slug> is required');

async function getPublicStore({ bypassEdge = false } = {}) {
  // The read path the storefront itself uses to resolve a store by slug. It is
  // edge-cached (s-maxage 120, stale-while-revalidate 600), so the PLAIN URL is
  // what a storefront render sees; `bypassEdge` adds a throwaway query param
  // to read the origin (Redis-cached, busted by the theme PUT).
  const q = bypassEdge ? `?_sbl=${Date.now()}` : '';
  const res = await fetch(`${API}/api/v1/public/stores/${encodeURIComponent(STORE)}${q}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (!res.ok) die(`GET public store "${STORE}" → HTTP ${res.status}`);
  const body = await res.json();
  const store = body?.data?.store ?? body?.data ?? body?.store;
  if (!store?.id) die(`public store response for "${STORE}" has no id`);
  return store;
}

const before = await getPublicStore();
const theme = before.theme && typeof before.theme === 'object' ? before.theme : {};
console.log(`Mode:   ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}`);
console.log(`API:    ${API}`);
console.log(`Store:  ${before.slug ?? STORE} (${before.id})`);
console.log(`Theme keys now: ${Object.keys(theme).length}`);
console.log(`theme.${KEY} now: ${JSON.stringify(theme[KEY])}`);

if (theme[KEY] === true) {
  console.log('Already set — nothing to do.');
  process.exit(0);
}

const body = { [KEY]: true };
console.log(`Would send: PUT ${API}/api/v1/stores/${before.id}/theme  ${JSON.stringify(body)}`);
console.log('(shallow merge — every other theme key is left exactly as it is)');

if (!APPLY) process.exit(0);
if (!TOKEN) die('FWB_ADMIN_TOKEN is required with --apply');

const put = await fetch(`${API}/api/v1/stores/${before.id}/theme`, {
  method: 'PUT',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify(body),
});
if (!put.ok) die(`PUT theme → HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`);

// Verify from the public read path (origin), not from the PUT's own response.
const after = await getPublicStore({ bypassEdge: true });
const afterTheme = after.theme && typeof after.theme === 'object' ? after.theme : {};
const lost = Object.keys(theme).filter(k => !(k in afterTheme));
if (afterTheme[KEY] !== true)
  die(`verification failed: theme.${KEY} is ${JSON.stringify(afterTheme[KEY])}`, 1);
if (lost.length) die(`verification failed: theme keys disappeared: ${lost.join(', ')}`, 1);
console.log(
  `Verified at origin: theme.${KEY} = true; ${Object.keys(afterTheme).length} theme keys (none lost).`
);

// The storefront reads the edge-cached URL. Until it shows the key too, do NOT
// deploy the #1998 code — re-run this script WITHOUT --apply (it reads the
// plain URL) until it prints "Already set".
const edge = await getPublicStore();
if (edge.theme?.[KEY] === true) {
  console.log('Edge (the URL the storefront reads) already shows it. Safe to deploy.');
} else {
  console.log(
    'Edge cache still serves the old theme (up to ~12 min). Re-run without --apply until it prints "Already set" before deploying.'
  );
}
