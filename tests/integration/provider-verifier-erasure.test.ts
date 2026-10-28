/**
 * Erasing a user nulls provider_verifications.verified_by_id (the confirming super-admin's id is personal
 * data; erasure classification d1:provider_verifications = scrub by userId). Postgres twin of
 * packages/repo/test/platform-erasure.test.ts, which proves the same on the D1 schema.
 * DB-direct, self-skips without a real DATABASE_URL.
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '@ebda/database';
import { scrubProviderVerifier } from '@api/services/provider-verification.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');
const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)('provider verification user erasure (Postgres)', () => {
  it('nulls verified_by_id for the erased user only and keeps verified_at', async () => {
    const a = `erase-a-${uid()}`;
    const b = `erase-b-${uid()}`;
    const verifiedAt = new Date('2026-10-01T00:00:00Z');
    await prisma.providerVerification.createMany({
      data: [
        { provider: a, kind: 'payment', verifiedAt, verifiedById: 'user-1' },
        { provider: b, kind: 'payment', verifiedAt, verifiedById: 'user-2' },
      ],
    });
    try {
      const count = await scrubProviderVerifier(prisma, 'user-1');
      expect(count).toBeGreaterThanOrEqual(1);
      const rows = await prisma.providerVerification.findMany({
        where: { provider: { in: [a, b] } },
        orderBy: { provider: 'asc' },
      });
      const byProvider = Object.fromEntries(rows.map(r => [r.provider, r]));
      expect(byProvider[a].verifiedById).toBeNull();
      expect(byProvider[a].verifiedAt?.toISOString()).toBe(verifiedAt.toISOString());
      expect(byProvider[b].verifiedById).toBe('user-2');
    } finally {
      await prisma.providerVerification.deleteMany({ where: { provider: { in: [a, b] } } });
    }
  });
});
