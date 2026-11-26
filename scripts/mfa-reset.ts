/**
 * MFA Reset CLI
 * =============
 * Disables MFA for a user by email and bumps tokenVersion so all existing
 * sessions are invalidated. Use as a last resort when an admin loses access
 * to their authenticator and has no backup codes.
 *
 * LAST RESORT (self-service A23): a user who still has an authenticator or unused
 * recovery codes makes a new set themselves (Account -> Security -> Recovery codes,
 * step-up = password + live code). Run this only after verifying identity, when both
 * are lost. See docs/runbooks/mfa-recovery.md. Super-admin/operator override: kept.
 *
 * Usage:
 *   DIRECT_URL=<prod-direct-url> npx tsx scripts/mfa-reset.ts <email>
 *
 * For local dev (reads from apps/api/.env automatically via dotenv):
 *   npx tsx scripts/mfa-reset.ts <email>
 *
 * The tokenVersion increment forces re-login everywhere for that user.
 * Pair with a Telegram/email notification to the user that they have been
 * signed out and must re-enroll 2FA after logging back in.
 */
import { prisma } from '@ebda/database';

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: mfa-reset.ts <email>');
    process.exit(1);
  }

  const result = await prisma.user.updateMany({
    where: { email },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: [],
      mfaEnrolledAt: null,
      tokenVersion: { increment: 1 },
    },
  });

  console.log(`MFA reset for ${email}: ${result.count} row(s)`);
  if (result.count === 0) {
    console.error('No user found with that email — double-check the address.');
    process.exit(1);
  }

  await prisma.$disconnect();
  process.exit(0);
})();
