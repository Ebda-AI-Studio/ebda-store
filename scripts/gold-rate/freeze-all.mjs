#!/usr/bin/env node
// Emergency brake for gold-rate pricing (Phase B5, Ruling B5-22): turn EVERY gold-priced product of one
// store (or of all stores) into a fixed-price product at the price it has right now. Use it when the rate
// source is wrong and the merchant cannot fix it in the admin, or before removing the feature for a store.
//
//   DATABASE_URL=<owner-role postgres url> \
//     npx tsx scripts/gold-rate/freeze-all.mjs [--store <slug>] [--apply] [--yes-production]
//
// DRY RUN BY DEFAULT: prints, per store, how many products would be frozen and writes nothing. `--apply`
// goes through GoldRateService.bulkSwitchMode (the real path: advisory lock, audited, repricer flag, and the
// IMMEDIATE price cache purge), 500 products per call, so a frozen price is never stale in any cache layer.
// Refuses any non-loopback DATABASE_URL unless `--yes-production` is passed: Ahmad approves that run, an
// agent never does (the storedemo seed's guard, reused). Safe to re-run: a product already fixed is skipped.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard } from '../storedemo/seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CHUNK = 500;

/** Parse argv into { apply, store, yesProduction } or { error }. Pure so it is unit-tested. */
export function parseArgs(argv) {
  const i = argv.indexOf('--store');
  const store = i >= 0 ? argv[i + 1] : null;
  if (i >= 0 && (!store || store.startsWith('--'))) return { error: '--store needs a store slug' };
  return {
    apply: argv.includes('--apply'),
    store,
    yesProduction: argv.includes('--yes-production'),
  };
}

/** Split ids into service-sized chunks. */
export function chunk(ids, size = CHUNK) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const url = process.env.DATABASE_URL ?? '';
  const g = guard(url, argv);
  if (!g.ok) {
    console.error(g.why);
    return 2;
  }
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  process.env.DIRECT_URL ??= url;
  const { createPrismaClient, runInStoreScope } = await import('@ebda/database');
  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  try {
    await prisma.$queryRaw`select 1`;
    const stores = await prisma.store.findMany({
      where: { ...(args.store ? { slug: args.store } : {}), deletedAt: null },
      select: { id: true, slug: true, ownerId: true },
      orderBy: { slug: 'asc' },
    });
    if (args.store && stores.length === 0) {
      console.error(`No store with slug "${args.store}".`);
      return 2;
    }
    const plan = [];
    for (const s of stores) {
      const rows = await prisma.product.findMany({
        where: { storeId: s.id, pricingMode: 'gold_rate', deletedAt: null },
        select: { id: true },
      });
      if (rows.length) plan.push({ ...s, ids: rows.map(r => r.id) });
    }
    console.log(
      `${args.apply ? 'APPLY' : 'DRY RUN'}: ${plan.reduce((n, p) => n + p.ids.length, 0)} gold-priced product(s) in ${plan.length} store(s) -> fixed price (the current price stays)`
    );
    for (const p of plan) console.log(`  ${p.slug} (${p.id}): ${p.ids.length} product(s)`);
    if (!args.apply || plan.length === 0) {
      if (!args.apply && plan.length) console.log('Nothing written. Re-run with --apply.');
      return 0;
    }
    const { GoldRateService } = await import(
      `${root}/apps/api/src/services/gold-rate/gold-rate.service.ts`
    );
    let failed = 0;
    for (const p of plan) {
      for (const ids of chunk(p.ids)) {
        try {
          const r = await runInStoreScope(p.id, () =>
            GoldRateService.bulkSwitchMode(p.id, ids, 'fixed', { userId: p.ownerId })
          );
          console.log(
            `  froze ${p.slug}: ${r.switched.length} switched, ${r.skipped.length} skipped`
          );
          for (const s of r.skipped) console.log(`    skipped ${s.id}: ${s.reason}`);
          failed += r.skipped.filter(s => s.reason !== 'ALREADY').length;
        } catch (e) {
          failed += 1;
          console.error(`  FAILED ${p.slug}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return failed ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    code => process.exit(code),
    e => {
      console.error(e);
      process.exit(1);
    }
  );
}
