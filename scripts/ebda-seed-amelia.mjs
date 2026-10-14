#!/usr/bin/env node
// Seed merchant #1 (Amelia Aurum, jewellery) into a LOCAL / STAGING database and
// import a catalogue CSV through the SAME code the admin "Bulk import" uses
// (csv-import.ts converter -> BulkService.importProducts -> product-cache bust).
//
//   DATABASE_URL=<loopback postgres url, e.g. a local container> \
//     npx tsx scripts/ebda-seed-amelia.mjs [--csv <file>] [--owner-email <email>] [--allow-remote]
//
// Run it with `tsx` (not bare node): it imports the API's TypeScript services.
//
// Safety: refuses any DATABASE_URL whose host is not loopback (localhost,
// 127.0.0.1, ::1) unless --allow-remote is passed. Never point this at production.
//
// Defaults to the SYNTHETIC fixture tests/fixtures/amelia-aurum-catalogue.csv;
// when Amelia Aurum's real export arrives, pass it with --csv. Re-running is
// idempotent: the store is reused and products are updated in place (SKU/slug).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// ---- DB guard (runs BEFORE any module that can open a connection is loaded) --
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is required (a local/staging Postgres).');
  process.exit(2);
}
let dbHost;
try {
  dbHost = new URL(dbUrl).hostname.replace(/^\[|\]$/g, '');
} catch {
  console.error('DATABASE_URL is not a valid URL.');
  process.exit(2);
}
const loopback = ['localhost', '127.0.0.1', '::1'].includes(dbHost.toLowerCase());
if (!loopback && !flag('--allow-remote')) {
  console.error(
    `Refusing to seed non-loopback database host "${dbHost}". ` +
      'This script is for local/staging only; pass --allow-remote if you really mean it.'
  );
  process.exit(2);
}
process.env.DIRECT_URL ??= dbUrl;

const csvPath = resolve(root, opt('--csv', 'tests/fixtures/amelia-aurum-catalogue.csv'));
const ownerEmail = opt('--owner-email', 'amelia-owner@ebda.local');

const { prisma, runInStoreScope, withUser } = await import('@ebda/database');
const { ensureAdminUser } = await import('../apps/api/src/lib/definer.ts');
const { StoreService } = await import('../apps/api/src/services/store.service.ts');
const { BulkService } = await import('../apps/api/src/services/bulk.service.ts');
const { decodeCsvBytes, importCsvToPlatformCsv } =
  await import('../apps/api/src/services/csv-import.ts');
const { invalidateStoreProductCaches } = await import('../apps/api/src/lib/public-cache.ts');

try {
  // ---- owner -----------------------------------------------------------------
  // The admin namespace (users.store_id NULL) is not visible from any RLS scope,
  // so find-or-create goes through the same `ebda_admin_user_ensure` definer the
  // API uses. Not a valid hash of anything: this account cannot log in. Set a real
  // password through the normal reset flow if a human needs to sign in.
  const admin = await ensureAdminUser({
    email: ownerEmail,
    passwordHash: '!seed-no-login',
    firstName: 'Amelia',
    lastName: 'Aurum',
    role: 'store_admin',
    emailVerified: true,
  });
  const owner = { id: admin.id };
  if (admin.created) {
    await withUser(owner.id, tx =>
      tx.user.update({ where: { id: owner.id }, data: { language: 'ar' } })
    );
  }

  // ---- store -----------------------------------------------------------------
  let store = await prisma.store.findUnique({ where: { slug: 'amelia' } });
  if (!store) {
    // StoreService.create seeds the chart of accounts + the 14% VAT rate and
    // stamps settings { currency: EGP, locale: ar-EG, defaultLanguage: ar }.
    store = await StoreService.create(owner.id, { name: 'Amelia Aurum', slug: 'amelia' });
  }
  store = await prisma.store.update({
    where: { id: store.id },
    data: {
      name: 'Amelia Aurum',
      nameAr: 'أميليا أوروم',
      currency: 'EGP',
      timezone: 'Africa/Cairo',
      status: 'active',
    },
  });

  // Amelia is a REGULAR paying client (Ruling EBDA-FUNNEL-15): no comped /
  // founding_free plan. The seed puts the store on Growth so the catalogue load
  // runs under real limits; in production Ahmad activates her paid period from
  // super-admin -> Billing -> "Record manual payment & activate" (InstaPay).
  const { planService } = await import('../apps/api/src/services/plan.service.ts');
  await planService.assignPlan(store.id, { planCode: 'growth' });
  store = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });

  // ---- import (same path as the admin Bulk import) ---------------------------
  const converted = importCsvToPlatformCsv(decodeCsvBytes(readFileSync(csvPath)));
  // Store scope, not one big tenant transaction: this is exactly how the Inngest
  // bulk-import function runs it (see bulk-import.ts for why).
  const result = await runInStoreScope(store.id, () =>
    BulkService.importProducts(store.id, converted.csv, { updateExisting: true }, owner.id)
  );
  await invalidateStoreProductCaches(store.id);

  console.log(
    JSON.stringify(
      {
        store: { id: store.id, slug: store.slug, host: `${store.slug}.ebda.app`, plan: store.plan },
        csv: { path: csvPath, format: converted.format },
        result: {
          total: result.total,
          created: result.created,
          updated: result.updated,
          variantsCreated: result.variantsCreated,
          failed: result.failed,
          errors: result.errors,
        },
      },
      null,
      2
    )
  );
  process.exitCode = result.failed > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
