// Idempotent: create-or-promote a super_admin user.
//
// Usage (run from apps/api/ so @ebda/database resolves):
//   node ../../scripts/admin-upsert-super-admin.mjs --email=foo@bar.com --password=secret
//   node ../../scripts/admin-upsert-super-admin.mjs --email=foo@bar.com --password=secret --apply
//
// Default = dry-run (prints the planned action, doesn't write).
// `--apply` performs the write.
//
// Behaviour:
//   - Existing user (any role): promotes to super_admin AND resets password.
//   - No existing user: creates a new super_admin with the given password.
//
// `super_admin` users have storeId=NULL (admin namespace). The partial
// unique index `users_admin_email_key` (set in 20260430030000) prevents
// duplicate global admin emails — promoting an existing customer-with-
// the-same-email-on-some-store would not collide with that index since
// customer rows have storeId set.
import 'dotenv/config';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) return [[m[1], m[2]]];
    if (a.startsWith('--')) return [[a.slice(2), true]];
    return [];
  })
);

const email = args.email;
const password = args.password;
const APPLY = Boolean(args.apply);

if (!email || !password) {
  console.error('Required: --email=<email> --password=<password>');
  console.error('Optional: --apply (without it, dry-run only)');
  process.exit(1);
}

const SALT_ROUNDS = 10;

const existing = await prisma.user.findFirst({
  where: { email, storeId: null },
});

if (existing) {
  console.log(`Existing admin user found: ${existing.id}`);
  console.log(`  current role: ${existing.role}`);
  console.log(`  status: ${existing.status}`);
  console.log(`Plan: promote to super_admin + reset password.`);
} else {
  // Check if email exists as a customer on any store — informational only,
  // we still create a fresh admin row with storeId=null.
  const asCustomer = await prisma.user.count({
    where: { email, storeId: { not: null } },
  });
  if (asCustomer > 0) {
    console.log(
      `Note: ${email} also exists as a customer on ${asCustomer} store(s). Those rows are independent of this admin row.`
    );
  }
  console.log(`No existing admin user with email ${email}.`);
  console.log(`Plan: create new super_admin.`);
}

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write.');
  await prisma.$disconnect();
  process.exit(0);
}

const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

if (existing) {
  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: {
      role: 'super_admin',
      passwordHash,
      status: 'active',
      emailVerified: true,
    },
    select: { id: true, email: true, role: true, status: true, emailVerified: true },
  });
  console.log('✓ Updated:', updated);
} else {
  const created = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      role: 'super_admin',
      status: 'active',
      emailVerified: true,
      language: 'en',
    },
    select: { id: true, email: true, role: true, status: true, emailVerified: true },
  });
  console.log('✓ Created:', created);
}

await prisma.$disconnect();
