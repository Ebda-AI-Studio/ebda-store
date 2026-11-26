/**
 * R-TRIAL-ONCE-1: the used-trial marker is keyed by the NORMALISED email (a re-registered address is the same owner),
 * stores only a hash, and a failed write never fails a store that already exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), fail: false }));
vi.mock('@ebda/database', () => ({ withUser: vi.fn() }));
vi.mock('@api/lib/platform-db', () => ({
  platformDb: async () => ({
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        db.rows.has(where.key) ? { id: 'x' } : null,
      // `createMany ... skipDuplicates` over a unique key: ONE synchronous insert-or-skip, count = rows inserted
      createMany: async ({ data }: { data: Array<{ key: string }>; skipDuplicates?: boolean }) => {
        if (db.fail) throw new Error('d1 down');
        let count = 0;
        for (const row of data)
          if (!db.rows.has(row.key)) {
            db.rows.set(row.key, row);
            count++;
          }
        return { count };
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        db.rows.delete(where.key);
      },
    },
  }),
}));
vi.mock('@api/lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  normalizeTrialEmail,
  claimOwnerTrial,
  ownerHasUsedTrial,
  releaseOwnerTrial,
} from '@api/services/billing/trial-eligibility';

beforeEach(() => {
  db.rows.clear();
  db.fail = false;
});

describe('trial-eligibility', () => {
  it('unmarked owner may start a trial; after the claim (any case/space of the email) they may not', async () => {
    expect(await ownerHasUsedTrial('Owner@Example.com')).toBe(false);
    expect(await claimOwnerTrial('Owner@Example.com')).toEqual({ grant: true, owned: true });
    expect(await ownerHasUsedTrial(' owner@example.COM ')).toBe(true);
    expect(await ownerHasUsedTrial('other@example.com')).toBe(false);
  });

  it('the key holds a sha256, never the address', async () => {
    await claimOwnerTrial('owner@example.com');
    const [k] = [...db.rows.keys()];
    expect(k).toMatch(/^ebda\.trial-used:[0-9a-f]{64}$/);
    expect(k).not.toContain('owner');
  });

  it('RACE: concurrent claims of one address (any case) -> exactly one grant and one owner', async () => {
    const claims = await Promise.all(
      ['a@b.co', 'A@B.co', ' a@b.co ', 'a@b.CO'].map(e => claimOwnerTrial(e))
    );
    expect(claims.filter(c => c.grant)).toHaveLength(1);
    expect(claims.filter(c => c.owned)).toHaveLength(1);
    expect(db.rows.size).toBe(1);
  });

  it('a second claim after the first is refused (no grant, not owned)', async () => {
    await claimOwnerTrial('a@b.co');
    expect(await claimOwnerTrial('a@b.co')).toEqual({ grant: false, owned: false });
  });

  it('a marker store that fails is logged, not retried, and FAILS IN THE MERCHANT FAVOUR: grant, but not owned', async () => {
    db.fail = true;
    expect(await claimOwnerTrial('a@b.co')).toEqual({ grant: true, owned: false });
  });

  it('release gives a claimed marker back so the next create may claim it', async () => {
    await claimOwnerTrial('a@b.co');
    await releaseOwnerTrial('a@b.co');
    expect(await ownerHasUsedTrial('a@b.co')).toBe(false);
    expect(await claimOwnerTrial('a@b.co')).toEqual({ grant: true, owned: true });
  });
});

describe('one trial per MAILBOX, not per spelling (security review of #861)', () => {
  it('+tag, dots, googlemail and mixed case all normalise to one address', () => {
    for (const alias of [
      'owner+1@gmail.com',
      'o.w.n.e.r@gmail.com',
      'O.Wner+promo@GoogleMail.com',
      ' Owner@Gmail.COM ',
      'owner@googlemail.com',
    ])
      expect(normalizeTrialEmail(alias)).toBe('owner@gmail.com');
  });

  it('+tag is stripped on every domain, dots only matter on Gmail', () => {
    expect(normalizeTrialEmail('shop+eg@example.com')).toBe('shop@example.com');
    expect(normalizeTrialEmail('a.b@example.com')).toBe('a.b@example.com');
    expect(normalizeTrialEmail('+x@gmail.com')).toBe('+x@gmail.com'); // would be empty: keeps its form
  });

  it('a different real address is a different mailbox', () => {
    expect(normalizeTrialEmail('owner2@gmail.com')).not.toBe(
      normalizeTrialEmail('owner@gmail.com')
    );
    expect(normalizeTrialEmail('owner@example.com')).not.toBe(
      normalizeTrialEmail('owner@gmail.com')
    );
  });

  it('a claim by one alias blocks every other alias, and a different address still gets its own trial', async () => {
    expect(await claimOwnerTrial('owner@gmail.com')).toEqual({ grant: true, owned: true });
    for (const alias of [
      'owner+1@gmail.com',
      'o.w.n.e.r@gmail.com',
      'owner@googlemail.com',
      'OWNER@gmail.com',
    ]) {
      expect(await ownerHasUsedTrial(alias)).toBe(true);
      expect(await claimOwnerTrial(alias)).toEqual({ grant: false, owned: false });
    }
    expect(await ownerHasUsedTrial('someone.else@gmail.com')).toBe(false);
    expect(await claimOwnerTrial('someone.else@gmail.com')).toEqual({ grant: true, owned: true });
  });

  it('RACE: concurrent claims through different aliases of one mailbox -> exactly one grant', async () => {
    const claims = await Promise.all(
      ['a.b@gmail.com', 'ab+1@gmail.com', 'AB@googlemail.com', 'ab@gmail.com'].map(e =>
        claimOwnerTrial(e)
      )
    );
    expect(claims.filter(c => c.grant)).toHaveLength(1);
    expect(db.rows.size).toBe(1);
  });

  it('BACKWARD COMPATIBLE: a marker written under the OLD key (plain lowercase) still blocks the address and its aliases; new claims write the new key', async () => {
    const crypto = await import('node:crypto');
    const old =
      'ebda.trial-used:' + crypto.createHash('sha256').update('o.w.n.e.r@gmail.com').digest('hex');
    db.rows.set(old, { key: old });
    expect(await ownerHasUsedTrial('O.W.N.E.R@gmail.com')).toBe(true); // the exact old spelling
    expect(await claimOwnerTrial('o.w.n.e.r@gmail.com')).toEqual({ grant: false, owned: false });
    expect(db.rows.size).toBe(1); // nothing new written for an owner who already had a trial
    // a fresh owner writes the NEW (normalised) key, never the legacy spelling
    await claimOwnerTrial('fresh.owner+x@gmail.com');
    const fresh =
      'ebda.trial-used:' + crypto.createHash('sha256').update('freshowner@gmail.com').digest('hex');
    expect(db.rows.has(fresh)).toBe(true);
  });

  it('release removes only the new key a request created, never an older marker', async () => {
    await claimOwnerTrial('a.b@gmail.com');
    await releaseOwnerTrial('ab+2@gmail.com'); // same mailbox, same new key
    expect(await ownerHasUsedTrial('ab@gmail.com')).toBe(false);
  });
});
