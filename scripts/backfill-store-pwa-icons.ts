/**
 * One-time backfill: generate the full B5 PWA icon set (icon384,
 * iconAppleTouch, favicon32, favicon16, maskableIcon, iconSource) for every
 * store that already has PWA enabled with an `icon512` uploaded under the
 * pre-B5 three-field form, but hasn't run the new generator yet.
 *
 * docs/superpowers/plans/2026-05-04-storefront-per-store-pwa-full-sizes.md,
 * task 7. As of 2026-09-25 there are 3 live stores (demo-store, demo-boutique,
 * demo-shop) — this is small and one-off, not a recurring job.
 *
 * DEVIATION FROM THE 2026-05-04 PLAN: written as `.ts` (not `.mjs`) so it can
 * import `generatePwaIconSet`/`PWAService` directly from
 * `apps/api/src/services/pwa.service.ts` — matching this repo's established
 * pattern for one-off scripts that need API-layer code
 * (`scripts/backfill-slug-redirects.ts` does the same). Run with `tsx`
 * exactly as the plan says, just a `.ts` extension.
 *
 * NOT wrapped in runInTenantContext/withRlsBypass: `stores` (unlike its
 * tenant-scoped children) carries no RLS policy — verified against
 * packages/database/prisma/migrations/**\/migration.sql, no
 * `ENABLE ROW LEVEL SECURITY` targets it — and the sibling one-off script
 * this file's header points to (backfill-slug-redirects.ts) reads/writes
 * `prisma.store`/`prisma.product` the same unwrapped way, run via the full
 * DATABASE_URL exactly as this one is. Wrapping would add the request-path
 * transaction machinery to a one-off script with no access-control gap to
 * close.
 *
 * SAFETY (per the B5 task instructions — do NOT run this against a real
 * database from an agent session):
 *   - Defaults to DRY RUN. Nothing is written unless `--apply` is passed.
 *   - Idempotent: a store already carrying `iconAppleTouch` is skipped, so
 *     a repeated `--apply` run (e.g. after adding a 4th store) only touches
 *     stores that still need it.
 *   - Optional `--store <storeId|slug>` scopes to one store, same flag
 *     convention as backfill-slug-redirects.ts.
 *
 * USAGE (the owner runs this AFTER this PR is deployed, from apps/api per
 * the plan's `railway run` invocation):
 *
 *   # Dry run against every eligible store (prints what WOULD change):
 *   railway run --service api -- npx tsx ../../scripts/backfill-store-pwa-icons.ts
 *
 *   # Scope to one store while testing:
 *   railway run --service api -- npx tsx ../../scripts/backfill-store-pwa-icons.ts --store demo-boutique
 *
 *   # Apply for real, once the dry-run output looks right:
 *   railway run --service api -- npx tsx ../../scripts/backfill-store-pwa-icons.ts --apply
 *
 * Or from the repo root against a local/staging DATABASE_URL:
 *   npx tsx scripts/backfill-store-pwa-icons.ts [--store <id|slug>] [--apply]
 */
import { fileURLToPath } from 'url';
import { prisma } from '@ebda/database';
import {
  generatePwaIconSet,
  PWAService,
  type PWASettings,
} from '../apps/api/src/services/pwa.service';

const APPLY = process.argv.includes('--apply');
const storeArgIdx = process.argv.indexOf('--store');
const STORE_FILTER = storeArgIdx !== -1 ? process.argv[storeArgIdx + 1] : undefined;

/**
 * Whether `updateSettings`'s own return value (the row Prisma's
 * `UPDATE ... RETURNING` produced, not a second query) shows the icon set we
 * asked it to write. Exported and pure so it can be unit-tested without
 * running the script or touching a database.
 */
export function iconWriteLanded(
  returned: Partial<PWASettings>,
  expected: Pick<PWASettings, 'iconAppleTouch'>
): boolean {
  return returned.iconAppleTouch === expected.iconAppleTouch;
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (STORE_FILTER) console.log(`Scoped to store: ${STORE_FILTER}`);

  const stores = await prisma.store.findMany({
    where: {
      pwaEnabled: true,
      ...(STORE_FILTER ? { OR: [{ id: STORE_FILTER }, { slug: STORE_FILTER }] } : {}),
    },
    select: { id: true, name: true, slug: true, pwaSettings: true },
  });

  console.log(`PWA-enabled stores found: ${stores.length}\n`);

  let generated = 0;
  let alreadyDone = 0;
  let noSource = 0;
  let failed = 0;

  for (const store of stores) {
    const settings = (store.pwaSettings as Partial<PWASettings>) || {};
    const label = `${store.slug} (${store.name})`;

    if (settings.iconAppleTouch) {
      alreadyDone += 1;
      console.log(`  SKIP  ${label} — already has the full icon set (iconAppleTouch is set)`);
      continue;
    }

    const source = settings.icon512 || settings.icon192;
    if (!source) {
      noSource += 1;
      console.log(`  SKIP  ${label} — pwaEnabled but no icon512/icon192 to generate from`);
      continue;
    }

    try {
      console.log(`  ${APPLY ? 'GENERATE' : 'WOULD GENERATE'}  ${label} — from ${source}`);
      if (!APPLY) {
        generated += 1;
        continue;
      }
      const buffer = await fetchImageBuffer(source);
      const icons = await generatePwaIconSet(store.id, buffer);
      const result = await PWAService.updateSettings(store.id, { settings: icons });

      // Confirm the write actually landed rather than trusting that
      // updateSettings() not throwing means it did. Checked against the row
      // updateSettings() itself returned from the UPDATE ... RETURNING (not
      // a second query), so this cannot pass on a stale read.
      if (!iconWriteLanded(result.settings, icons)) {
        throw new Error(
          `updateSettings returned iconAppleTouch=${result.settings.iconAppleTouch ?? '(unset)'}, ` +
            `expected ${icons.iconAppleTouch} — the write did not land as generated`
        );
      }

      console.log(
        `           -> icon384=${icons.icon384}\n           -> iconAppleTouch=${icons.iconAppleTouch}\n           -> favicon32=${icons.favicon32}\n           -> favicon16=${icons.favicon16}`
      );
      generated += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAILED  ${label}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `\n${APPLY ? 'Generated' : 'Would generate'}: ${generated}, already done: ${alreadyDone}, no source: ${noSource}, failed: ${failed}`
  );
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write.');
}

// Only run when this file is executed directly as a CLI (`npx tsx
// scripts/backfill-store-pwa-icons.ts`) — never as a side effect of a test
// file importing `iconWriteLanded` from this module.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
