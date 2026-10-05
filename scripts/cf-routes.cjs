#!/usr/bin/env node
// Shared package is built before config generation in CI. Fail loud if absent.
const { BRAND } = require('../packages/shared/dist/brand/index.js');
const app = process.argv[2];
const host = {
  web: BRAND.domains.marketing,
  admin: BRAND.domains.app,
  orders: BRAND.domains.orders,
}[app];
if (!host) throw new Error(`Unsupported Cloudflare app: ${app}`);
const routes = [
  { pattern: host, custom_domain: true },
  ...(app === 'web'
    ? [
        { pattern: `cf.${BRAND.domains.marketing}`, custom_domain: true },
        { pattern: '*/*', zone_name: BRAND.domains.marketing },
      ]
    : [{ pattern: `${host}/*`, zone_name: BRAND.domains.marketing }]),
];
process.stdout.write(`  "routes": ${JSON.stringify(routes, null, 2).replace(/\n/g, '\n  ')},\n`);
