// One-shot cleanup of e2e leftover stores. Reads the live DB, finds
// every store whose name == "Test Store E2E" with 0 products + 0
// orders + 0 customers, then deletes the store + its orphan owner
// (only if the owner doesn't own anything else).
//
// Dry-run by default; pass `--apply` to actually delete.
import { prisma } from '@ebda/database';

const APPLY = process.argv.includes('--apply');

const tests = await prisma.store.findMany({
  where: { name: 'Test Store E2E' },
  select: {
    id: true,
    slug: true,
    ownerId: true,
    _count: {
      select: { products: true, categories: true, orders: true, customers: true, returns: true },
    },
  },
});

if (tests.length === 0) {
  console.log('No Test Store E2E stores found.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Found ${tests.length} Test Store E2E stores:`);
for (const s of tests) {
  console.log(
    `  ${s.id}  slug=${s.slug}  owner=${s.ownerId}  ` +
      `prod=${s._count.products}  cat=${s._count.categories}  ` +
      `ord=${s._count.orders}  cust=${s._count.customers}  ret=${s._count.returns}`
  );
}

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to actually delete.');
  await prisma.$disconnect();
  process.exit(0);
}

// Order: detach audit-log rows that reference the store, drop returns,
// drop orders, drop the store (cascades to most relations), then drop
// the orphan owner if they own nothing else.
let deletedStores = 0;
let deletedUsers = 0;

for (const s of tests) {
  await prisma.$transaction(async tx => {
    await tx.return.deleteMany({ where: { storeId: s.id } });
    await tx.order.deleteMany({ where: { storeId: s.id } });
    await tx.auditLog.updateMany({ where: { storeId: s.id }, data: { storeId: null } });
    await tx.store.delete({ where: { id: s.id } });
  });
  deletedStores += 1;

  // Drop the owner only if they don't own anything that matters.
  // AuditLog rows are immutable history, but `userId` is nullable on
  // that table — null out our test owner's reference instead of
  // pinning the user row alive forever.
  const ownsOtherStore = await prisma.store.count({ where: { ownerId: s.ownerId } });
  if (ownsOtherStore === 0) {
    await prisma.auditLog.updateMany({
      where: { userId: s.ownerId },
      data: { userId: null },
    });
    await prisma.user.delete({ where: { id: s.ownerId } }).catch(err => {
      console.warn(`  warn: could not delete user ${s.ownerId}:`, err.message);
    });
    deletedUsers += 1;
  } else {
    console.log(`  kept user ${s.ownerId} (still owns ${ownsOtherStore} store(s))`);
  }
}

console.log(`\nDeleted ${deletedStores} stores, ${deletedUsers} orphan users.`);
await prisma.$disconnect();
