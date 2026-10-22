#!/usr/bin/env node
// Move a store that is still on the retired night + gold Dahab skin (`template = 'dahab'` and
// `look IS NULL`) onto one of the three new looks (Ruling B5-3).
//
//   DATABASE_URL=<owner-role postgres url> \
//     npx tsx scripts/dahab-demo/migrate-legacy-dahab.mjs [--apply] [--look dahab.worn] [--yes-production]
//
// DRY RUN BY DEFAULT: prints the plan (every legacy store found, and per store the look-owned theme
// keys the merchant still has stored, which are the keep-diff: under `design: 'keep'` they stay as
// the merchant's overrides on top of the new look) and writes nothing. `--apply` calls
// StoreService.applyLook(id, look, { design: 'keep' }), the real merchant path, because SQL cannot do
// the field-level keep-diff or the cache purge. On a store that already has a builder revision
// applyLook writes a DRAFT, never the live page: the merchant reviews and publishes it. A store
// already on any `dahab.*` look is not selected, so a second run does nothing (idempotent).
//
// Refuses any non-loopback DATABASE_URL unless `--yes-production` is passed: Ahmad approves that
// run, an agent never does (the storedemo seed's guard, reused). Production had 0 such rows on
// 2026-10-21 (plan Inventory), so this is a safety net for a future import or a restored backup.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard } from '../storedemo/seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_LOOK = 'dahab.worn';

/** The look-owned theme keys a store still has stored: the keep-diff the report prints. */
export function keepDiff(theme, ownedKeys) {
  if (!theme || typeof theme !== 'object') return [];
  return ownedKeys.filter(k => Object.prototype.hasOwnProperty.call(theme, k));
}

/** Parse argv into { apply, look, yesProduction } or { error }. Pure so it is unit-tested. */
export function parseArgs(argv, isDahabLook) {
  const i = argv.indexOf('--look');
  const look = i >= 0 ? argv[i + 1] : DEFAULT_LOOK;
  if (!look || !isDahabLook(look))
    return { error: `--look must be one of the dahab.* looks, got "${look}"` };
  return {
    apply: argv.includes('--apply'),
    look,
    yesProduction: argv.includes('--yes-production'),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const url = process.env.DATABASE_URL ?? '';
  const g = guard(url, argv);
  if (!g.ok) {
    console.error(g.why);
    return 2;
  }
  process.env.DIRECT_URL ??= url;
  const { createPrismaClient, runInStoreScope } = await import('@ebda/database');
  const { getLook, LOOK_OWNED_THEME_KEYS } = await import('@ebda/shared');
  const args = parseArgs(argv, id => getLook(id)?.template === 'dahab');
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  try {
    await prisma.$queryRaw`select 1`;
    const stores = await prisma.store.findMany({
      where: { template: 'dahab', look: null },
      select: { id: true, slug: true, ownerId: true, theme: true },
      orderBy: { slug: 'asc' },
    });
    console.log(
      `${args.apply ? 'APPLY' : 'DRY RUN'}: ${stores.length} legacy Dahab store(s) -> ${args.look} (design: keep)`
    );
    for (const s of stores) {
      const kept = keepDiff(s.theme, LOOK_OWNED_THEME_KEYS);
      console.log(
        `  ${s.slug} (${s.id}): ${kept.length} look-owned theme key(s) stay as the merchant's overrides${kept.length ? ': ' + kept.join(', ') : ''}`
      );
    }
    if (!args.apply || stores.length === 0) {
      if (!args.apply && stores.length) console.log('Nothing written. Re-run with --apply.');
      return 0;
    }
    const { StoreService } = await import(`${root}/apps/api/src/services/store.service.ts`);
    let failed = 0;
    for (const s of stores) {
      try {
        const r = await runInStoreScope(s.id, () =>
          StoreService.applyLook(s.id, args.look, { design: 'keep' }, s.ownerId)
        );
        console.log(
          `  applied ${s.slug}: home ${r.builder}${r.builder === 'draft' ? ' (a DRAFT: the merchant publishes it)' : ''}`
        );
      } catch (e) {
        failed += 1;
        console.error(`  FAILED ${s.slug}: ${e instanceof Error ? e.message : String(e)}`);
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
