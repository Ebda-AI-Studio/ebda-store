#!/usr/bin/env node
// Generate the wrangler configs for the ISOLATED preview stack
// (docs/ebda/templates/dahab.md, "Preview stack"):
//
//   ebda-api-preview    api-preview.ebda.app    Hyperdrive → Neon branch `preview` (ebda_app)
//   ebda-web-preview    <host>.ebda.app         storefront, NEXT_PUBLIC_API_URL = api-preview
//   ebda-admin-preview  admin-preview.ebda.app  merchant admin
//
// Every binding is the preview's own: Hyperdrive, KV, queues, rate-limit
// namespace, Durable Objects (per worker). No cron triggers (nothing scheduled
// runs on preview), no ISR R2 bucket (the storefront builds with
// OPENNEXT_CACHE=false), no production route. Each worker is bound to a
// custom domain + a host-specific zone route on ONE hostname each, which take
// precedence over the production `*.ebda.app/*` route for that hostname only.
//
//   PREVIEW_HYPERDRIVE_ID=… PREVIEW_KV_ID=… [PREVIEW_STORE_HOSTS=dahab-preview.ebda.app] \
//     node scripts/preview/preview-config.mjs api|web|admin
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSON5 = require('json5');
const root = new URL('../../', import.meta.url);
const app = process.argv[2];
const ZONE = 'ebda.app';
const API_HOST = `api-preview.${ZONE}`;
const ADMIN_HOST = `admin-preview.${ZONE}`;
const STORE_HOSTS = (process.env.PREVIEW_STORE_HOSTS ?? `dahab-preview.${ZONE}`).split(',');
const id32 = name => {
  const v = process.env[name] ?? '';
  if (!/^[a-f0-9]{32}$/i.test(v))
    throw new Error(`${name} must be a 32-hex Cloudflare resource id`);
  return v;
};
for (const h of [API_HOST, ADMIN_HOST, ...STORE_HOSTS]) {
  // Never a production hostname: the preview owns *-preview hosts only.
  if (!/^[a-z0-9-]+-preview\.ebda\.app$/.test(h)) throw new Error(`refusing non-preview host ${h}`);
}
// Custom domain (DNS + certificate) AND a host-specific zone route: zone
// routes run before custom domains, so without `<host>/*` the production
// storefront's `*.ebda.app/*` route would answer the preview host (observed
// on the first deploy). The specific route outranks the wildcard for that
// host only; every other *.ebda.app host keeps going to production.
const customDomains = hosts =>
  hosts.flatMap(host => [
    { pattern: host, custom_domain: true },
    { pattern: `${host}/*`, zone_name: ZONE },
  ]);

if (app === 'api') {
  const base = JSON5.parse(readFileSync(new URL('apps/api/wrangler.jsonc', root), 'utf8'));
  const cfg = {
    ...base,
    name: 'ebda-api-preview',
    main: 'src/preview-worker.ts',
    routes: customDomains([API_HOST]),
    hyperdrive: [{ binding: 'HYPERDRIVE', id: id32('PREVIEW_HYPERDRIVE_ID') }],
    kv_namespaces: [{ binding: 'KV_CACHE', id: id32('PREVIEW_KV_ID') }],
    queues: {
      producers: [
        { binding: 'EMAIL_QUEUE', queue: 'ebda-preview-email' },
        { binding: 'SMS_QUEUE', queue: 'ebda-preview-sms' },
      ],
      consumers: base.queues.consumers.map(c => ({
        ...c,
        queue: c.queue.replace(/^ebda-/, 'ebda-preview-'),
        ...(c.dead_letter_queue
          ? { dead_letter_queue: c.dead_letter_queue.replace(/^ebda-/, 'ebda-preview-') }
          : {}),
      })),
    },
    ratelimits: base.ratelimits.map(r => ({
      ...r,
      namespace_id: String(Number(r.namespace_id) + 100),
    })),
    triggers: { crons: [] },
    vars: {
      ...base.vars,
      WEB_URL: `https://${ADMIN_HOST}`,
      ADMIN_URL: `https://${ADMIN_HOST}`,
      API_URL: `https://${API_HOST}`,
      INNGEST_SERVE_HOST: `https://${API_HOST}`,
      PREVIEW_STACK: 'true',
    },
  };
  for (const q of [
    ...cfg.queues.producers.map(p => p.queue),
    ...cfg.queues.consumers.map(c => c.queue),
  ])
    if (!q.startsWith('ebda-preview-')) throw new Error(`queue ${q} is not a preview queue`);
  writeFileSync(new URL('apps/api/.wrangler.preview.jsonc', root), JSON.stringify(cfg, null, 2));
} else if (app === 'web' || app === 'admin') {
  const cfg = {
    name: `ebda-${app}-preview`,
    main: 'preview-worker-entry.ts',
    compatibility_date: app === 'web' ? '2025-08-16' : '2025-03-25',
    compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    services: [{ binding: 'WORKER_SELF_REFERENCE', service: `ebda-${app}-preview` }],
    routes: customDomains(app === 'web' ? STORE_HOSTS : [ADMIN_HOST]),
    vars: {
      CF_ENV_NAME: 'preview',
      // The builder canvas: the preview admin may frame the preview storefront
      // (also passed at build time — next.config.js reads it for the CSP).
      ...(app === 'web' ? { STOREFRONT_FRAME_ANCESTORS: `https://${ADMIN_HOST}` } : {}),
    },
    observability: { enabled: true },
  };
  writeFileSync(new URL(`apps/${app}/.wrangler.preview.jsonc`, root), JSON.stringify(cfg, null, 2));
} else {
  console.error('usage: preview-config.mjs api|web|admin');
  process.exit(2);
}
console.log(`wrote apps/${app}/.wrangler.preview.jsonc`);
