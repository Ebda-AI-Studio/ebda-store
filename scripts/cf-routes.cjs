#!/usr/bin/env node
// Shared package is built before config generation in CI. Fail loud if absent.
//
// Route ownership in the ebda.app zone (Ruling EBDA-DEPLOY-1):
//   ebda.app (apex)        → ebda-marketing (its own custom domain; NEVER claimed here)
//   api.ebda.app           → ebda-api (`api.ebda.app/*` route + custom domain)
//   admin./orders.ebda.app → ebda-admin / ebda-orders (custom domain + a specific
//                            `<host>/*` zone route — the route is what beats the
//                            storefront wildcard, which runs BEFORE custom domains)
//   <slug>.ebda.app        → ebda-web via the `*.ebda.app/*` zone route
// A `*.ebda.app/*` route does not match the bare apex. Hosts served by something
// else that the wildcard WOULD catch (media. = R2, preview. = marketing preview)
// get a Worker-less exclusion route — see docs/DEPLOYMENT.md "Storefront wildcard".
// The inherited FWB `*/*` + apex custom domain is deliberately gone: on Ebda it
// would steal the marketing apex.
const { BRAND } = require('../packages/shared/dist/brand/index.js');
const app = process.argv[2];
const zone = BRAND.domains.marketing;
const host = { admin: BRAND.domains.admin, orders: BRAND.domains.orders }[app];
let routes;
if (app === 'web') {
  routes = [{ pattern: `*${BRAND.domains.storeSuffix}/*`, zone_name: zone }];
} else if (host) {
  routes = [
    { pattern: host, custom_domain: true },
    { pattern: `${host}/*`, zone_name: zone },
  ];
} else {
  throw new Error(`Unsupported Cloudflare app: ${app}`);
}
process.stdout.write(`  "routes": ${JSON.stringify(routes, null, 2).replace(/\n/g, '\n  ')},\n`);
