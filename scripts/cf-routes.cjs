#!/usr/bin/env node
// Shared package is built before config generation in CI. Fail loud if absent.
//
// Route ownership in the ebda.app zone (Ruling EBDA-DEPLOY-1):
//   ebda.app (apex)        → ebda-marketing (its own custom domain; NEVER claimed here)
//   api.ebda.app           → ebda-api (`api.ebda.app/*` route + custom domain)
//   store./orders.ebda.app → ebda-admin / ebda-orders (custom domain + a specific
//                            `<host>/*` zone route — the route is what beats the
//                            storefront wildcard, which runs BEFORE custom domains)
//   <slug>.ebda.app        → ebda-web via the `*.ebda.app/*` zone route
// A `*.ebda.app/*` route does not match the bare apex. Hosts served by something
// else that the wildcard WOULD catch (media. = R2)
// get a Worker-less exclusion route — see docs/DEPLOYMENT.md "Storefront wildcard".
// The inherited Ebda Store `*/*` + apex custom domain was removed because `*/*` would steal the marketing apex; it is back (M-072)
// ONLY together with the explicit apex and accounts routes (ebda-marketing, ebda-accounts) that out-rank it.
const { BRAND } = require('../packages/shared/dist/brand/index.js');
const app = process.argv[2];
const zone = BRAND.domains.marketing;
const host = { admin: BRAND.domains.storeApp, orders: BRAND.domains.orders }[app];
let routes;
if (app === 'web') {
  // `*/*` (M-072, Cloudflare for SaaS): a merchant's own domain (shop.example.com CNAME -> the fallback origin) enters THIS zone
  // and is matched against this zone's Workers routes, so the storefront needs a route for ANY hostname
  // (https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/).
  // It is the LEAST specific pattern, so every explicit route below it still wins (route precedence: most specific pattern
  // wins, https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior). That is only safe because
  // EVERY other hostname in the zone has its own explicit route: apex (ebda-marketing), accounts, api, store, orders, docs, help,
  // status, and media (Worker-less exclusion). tests/unit/cf-route-precedence.test.ts proves it for each; add a route there
  // before adding a hostname served by anything other than the storefront.
  routes = [
    { pattern: `*${BRAND.domains.storeSuffix}/*`, zone_name: zone },
    { pattern: '*/*', zone_name: zone },
  ];
} else if (host) {
  routes = [
    { pattern: host, custom_domain: true },
    { pattern: `${host}/*`, zone_name: zone },
  ];
} else {
  throw new Error(`Unsupported Cloudflare app: ${app}`);
}
process.stdout.write(`  "routes": ${JSON.stringify(routes, null, 2).replace(/\n/g, '\n  ')},\n`);
