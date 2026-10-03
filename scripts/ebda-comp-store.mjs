#!/usr/bin/env node
// Put a store on the admin-granted `comped` plan (all limits unlimited, no
// platform fee, every feature on) — for merchant #1 and any later founding /
// partner merchant. The same call the super-admin Billing page makes.
//
//   DATABASE_URL=... npx tsx scripts/ebda-comp-store.mjs <slug> [--plan <code>] [--allow-remote]
//
// `--plan <code>` assigns another plan code instead (e.g. to un-comp: --plan free).
// Run with `tsx`: it imports the API's TypeScript services. Refuses a
// non-loopback DATABASE_URL unless --allow-remote is passed.

const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--plan');
const planIdx = args.indexOf('--plan');
const planCode = planIdx >= 0 && args[planIdx + 1] ? args[planIdx + 1] : 'comped';

if (!slug) {
  console.error('Usage: ebda-comp-store.mjs <store-slug> [--plan <code>] [--allow-remote]');
  process.exit(2);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
let host;
try {
  host = new URL(dbUrl).hostname.replace(/^\[|\]$/g, '');
} catch {
  console.error('DATABASE_URL is not a valid URL.');
  process.exit(2);
}
if (
  !['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase()) &&
  !args.includes('--allow-remote')
) {
  console.error(
    `Refusing non-loopback database host "${host}"; pass --allow-remote if you mean it.`
  );
  process.exit(2);
}
process.env.DIRECT_URL ??= dbUrl;

const { prisma } = await import('@force/database');
const { planService } = await import('../apps/api/src/services/plan.service.ts');

try {
  const store = await prisma.store.findUnique({ where: { slug } });
  if (!store) {
    console.error(`No store with slug "${slug}".`);
    process.exitCode = 1;
  } else {
    const result = await planService.assignPlan(store.id, { planCode });
    console.log(JSON.stringify({ store: store.slug, ...result }, null, 2));
  }
} finally {
  await prisma.$disconnect();
}
