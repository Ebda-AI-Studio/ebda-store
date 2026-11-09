#!/usr/bin/env node
// Fill the DEMO stores' home pages on their StoreDO (Ruling DEMO-SEED-DO-1). The home half of seed.mjs, ported off Postgres:
// it builds each home with the same `build<X>Home` builders and writes it through the API Worker's operator channel
// `/api/v1/internal/demo-home/:slug` (apps/api/src/routes/demo-home.routes.ts), which saves + publishes through the
// page-builder service and refuses any store that is not `is_demo`.
//
//   DEMO_SEED_TOKEN=... node scripts/storedemo/seed-home-do.mjs --api-url https://api.ebda.app [--template qamar|souq|jasmine|lamma|dahab|all] [--apply]
//
// Dry run by default: reads each demo home, builds the new one and prints what would change; nothing is written.
// `--apply` writes. Idempotent: a home whose published content already equals the built one is left alone, and every
// written home is read back and compared. Only the five demo slugs in TEMPLATE_SPECS can be named (non-demo slugs are
// refused here AND by the Worker). Images come from each template's production asset base (or <TPL>_DEMO_ASSET_BASE).
// The catalogue is NOT touched: the demo catalogues already live on their DOs.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_SPECS, assetBase, videoUrl } from './seed.mjs';
import { httpClient, seedOne } from './seed-home-do-lib.mjs';

/** The only slugs this script may write: the five showroom stores. */
export const DEMO_SLUGS = new Set(Object.values(TEMPLATE_SPECS).map(s => s.slug));

export function assetsFor(spec, env = process.env) {
  const a = assetBase([], env, spec);
  if (!a.ok) throw new Error(a.why);
  return { img: f => `${a.base}/${f}`, video: videoUrl(a.base) };
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      'api-url': { type: 'string' },
      template: { type: 'string', default: 'all' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!a['api-url'])
    throw new Error('--api-url is required (https://api.ebda.app, or a local wrangler dev)');
  const token = process.env.DEMO_SEED_TOKEN;
  if (!token || token.length < 24)
    throw new Error('DEMO_SEED_TOKEN (24+ chars, the Worker secret) is required');
  const specs =
    a.template === 'all'
      ? Object.values(TEMPLATE_SPECS)
      : [TEMPLATE_SPECS[a.template]].filter(Boolean);
  if (specs.length === 0)
    throw new Error(
      `unknown --template ${a.template}; one of ${Object.keys(TEMPLATE_SPECS).join(', ')}, all`
    );
  console.log(`${a.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'} against ${a['api-url']}`);
  const http = httpClient(a['api-url'], token);
  let failed = 0;
  for (const spec of specs) {
    try {
      const r = await seedOne(spec, {
        http,
        apply: a.apply,
        assets: assetsFor(spec),
        demoSlugs: DEMO_SLUGS,
      });
      console.log(r.line);
    } catch (e) {
      failed++;
      console.error(`${spec.slug}: FAILED ${e.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
