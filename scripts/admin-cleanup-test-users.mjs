// Sweep the 3 test-only user rows whose Test Store E2E stores were
// already deleted. They no longer own anything; their audit-log refs
// can be nulled out (userId is nullable on the audit_logs table) and
// the user rows themselves dropped.
import { prisma } from '@force/database';

const APPLY = process.argv.includes('--apply');

const candidates = [
  '71c2bb63-8578-47e7-af3f-11a4b0e9e22d',
  '0e10e692-37a8-4c7c-896d-0e12ebbf0a45',
  'b296fe39-904e-4dd9-ba2a-61af8d4882b8',
];

for (const userId of candidates) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      _count: { select: { auditLogs: true } },
    },
  });
  if (!user) {
    console.log(`  ${userId} — already gone`);
    continue;
  }
  const ownsStore = await prisma.store.count({ where: { ownerId: userId } });
  console.log(
    `  ${userId} email=${user.email} role=${user.role} ownsStore=${ownsStore} audit=${user._count.auditLogs}`
  );
  if (ownsStore !== 0) {
    console.log(`    skipped (still owns ${ownsStore} store)`);
    continue;
  }
  if (!APPLY) continue;
  await prisma.auditLog.updateMany({ where: { userId }, data: { userId: null } });
  await prisma.user.delete({ where: { id: userId } });
  console.log(`    deleted`);
}

await prisma.$disconnect();
if (!APPLY) console.log('\nDRY RUN — pass --apply to delete.');
