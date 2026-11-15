/**
 * R-TRIAL-ONCE-1: the used-trial marker is keyed by the NORMALISED email (a re-registered address is the same owner),
 * stores only a hash, and a failed write never fails a store that already exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), fail: false }));
vi.mock('@ebda/database', () => ({
  prisma: {
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        db.rows.has(where.key) ? { id: 'x' } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: unknown }) => {
        if (db.fail) throw new Error('d1 down');
        if (!db.rows.has(where.key)) db.rows.set(where.key, create);
      },
    },
  },
}));
vi.mock('@api/lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { markOwnerTrialUsed, ownerHasUsedTrial } from '@api/services/billing/trial-eligibility';

beforeEach(() => {
  db.rows.clear();
  db.fail = false;
});

describe('trial-eligibility', () => {
  it('unmarked owner may start a trial; after the mark (any case/space of the email) they may not', async () => {
    expect(await ownerHasUsedTrial('Owner@Example.com')).toBe(false);
    await markOwnerTrialUsed('Owner@Example.com', 's1');
    expect(await ownerHasUsedTrial(' owner@example.COM ')).toBe(true);
    expect(await ownerHasUsedTrial('other@example.com')).toBe(false);
  });

  it('the key holds a sha256, never the address', async () => {
    await markOwnerTrialUsed('owner@example.com', 's1');
    const [k] = [...db.rows.keys()];
    expect(k).toMatch(/^ebda\.trial-used:[0-9a-f]{64}$/);
    expect(k).not.toContain('owner');
  });

  it('a failed marker write is swallowed (the store already exists)', async () => {
    db.fail = true;
    await expect(markOwnerTrialUsed('a@b.co', 's1')).resolves.toBeUndefined();
  });
});
