#!/usr/bin/env node
// Move Amelia Aurum's store off the hidden `comped` plan onto Growth (InstaPay).
// Ruling EBDA-FUNNEL-15/-19. DRY RUN unless --apply. A production DATA action: the
// controller/Ahmad decides when to run it; nothing here runs it automatically.
//
//   DATABASE_URL=<url> npx tsx scripts/ebda-amelia-comp-migration.mjs \
//     (--store-id <uuid> | --slug <slug>) --covered-until 2026-12-01 [--interval monthly|yearly]
//   ... --apply --confirm <store-uuid>      # writes; --confirm must equal the resolved store id
//
// Idempotent: a store already on Growth is a no-op; anything not `comped` is refused.
// After applying, record her InstaPay payment in super-admin -> Billing ("Record manual
// payment & activate"); that creates the ledger row. This script moves no money.

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const die = (m, c = 2) => {
  console.error(m);
  process.exit(c);
};

if (!process.env.DATABASE_URL) die('DATABASE_URL is required.');
process.env.DIRECT_URL ??= process.env.DATABASE_URL;

const storeIdArg = opt('--store-id');
const slugArg = opt('--slug');
if (!!storeIdArg === !!slugArg) die('Pass exactly one of --store-id or --slug.');
const coveredRaw = opt('--covered-until');
if (!coveredRaw || !/^\d{4}-\d{2}-\d{2}$/.test(coveredRaw)) {
  die('--covered-until YYYY-MM-DD is required (the date she is covered through; UTC end of day).');
}
const coveredUntil = new Date(`${coveredRaw}T23:59:59.999Z`);
const interval = opt('--interval') ?? 'monthly';
if (!['monthly', 'yearly'].includes(interval)) die('--interval must be monthly or yearly.');
const apply = flag('--apply');

const { prisma } = await import('@ebda/database');
const { lookupStore } = await import('../apps/api/src/lib/definer.ts');
const { runCompMigration } = await import('../apps/api/src/services/billing/comp-migration.ts');

try {
  const store = await lookupStore(storeIdArg ? { id: storeIdArg } : { slug: slugArg }, [
    'active',
    'inactive',
    'suspended',
  ]);
  if (!store) die('Store not found.', 1);
  if (apply && opt('--confirm') !== store.id) {
    die(`--apply needs --confirm ${store.id} (must equal the resolved store id).`);
  }
  const r = await runCompMigration({ storeId: store.id, coveredUntil, interval }, { apply });
  console.log(
    JSON.stringify(
      { mode: apply ? 'APPLY' : 'DRY-RUN', storeId: store.id, status: store.status, ...r },
      null,
      2
    )
  );
  if (r.plan.action === 'refuse') process.exitCode = 1;
  if (!apply && r.plan.action === 'migrate')
    console.log('\nDry run only. Re-run with --apply --confirm <id>.');
} finally {
  await prisma.$disconnect();
}
