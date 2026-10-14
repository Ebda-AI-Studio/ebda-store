// Sweep store_admin users whose stores were all deleted.
//
// Background: store deletion used to cascade through products / categories /
// customers / etc. but left the owner User row behind. Those users can't
// log in usefully (no store to admin) and accumulate over time. This script
// finds every store_admin with zero owned stores and deletes them, nulling
// their auditLog references first (auditLog.userId is nullable).
//
// Run from apps/api/:
//   node ../../scripts/admin-cleanup-orphan-store-admins.mjs           # dry-run
//   node ../../scripts/admin-cleanup-orphan-store-admins.mjs --apply   # delete
//
// Default dry-run; --apply commits.
import 'dotenv/config';
import { prisma } from '@ebda/database';

const APPLY = process.argv.includes('--apply');

const orphans = await prisma.user.findMany({
  where: {
    role: 'store_admin',
    deletedAt: null,
    stores: { none: {} },
  },
  select: {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    createdAt: true,
    _count: { select: { auditLogs: true } },
  },
  orderBy: { createdAt: 'asc' },
});

if (orphans.length === 0) {
  console.log('No orphaned store_admin users. Nothing to do.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Found ${orphans.length} orphan store_admin user(s):`);
for (const u of orphans) {
  console.log(
    `  ${u.id}  ${u.email}  (audit_logs=${u._count.auditLogs}, created ${u.createdAt.toISOString().slice(0, 10)})`
  );
}

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to delete.');
  await prisma.$disconnect();
  process.exit(0);
}

let deleted = 0;
for (const u of orphans) {
  await prisma.$transaction(async tx => {
    await tx.auditLog.updateMany({ where: { userId: u.id }, data: { userId: null } });
    await tx.refreshToken.deleteMany({ where: { userId: u.id } });
    await tx.verificationToken.deleteMany({ where: { userId: u.id } });
    await tx.oneSignalSubscription.deleteMany({ where: { userId: u.id } });
    await tx.user.delete({ where: { id: u.id } });
  });
  deleted++;
  console.log(`  ✓ deleted ${u.email}`);
}

console.log(`\nDone — deleted ${deleted} orphan(s).`);
await prisma.$disconnect();
