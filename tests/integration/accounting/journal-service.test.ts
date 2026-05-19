import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { postEntry, reverseEntry } from '../../../apps/api/src/services/accounting/journal.service';
import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../../apps/api/src/services/accounting/account.service';

let storeId: string;
let cashId: string;
let revId: string;
const OWNER = '00000000-0000-0000-0000-0000000000aa';

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `je-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'JE',
      lastName: 'Owner',
    },
  });
  const s = await prisma.store.create({
    data: {
      name: `je-test-${Date.now()}`,
      slug: `je-test-${Date.now()}`,
      ownerId: OWNER,
    },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  cashId = await getSystemAccountIdByCode(storeId, '1000');
  revId = await getSystemAccountIdByCode(storeId, '4000');
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('journal.service', () => {
  it('posts a balanced entry', async () => {
    const entry = await postEntry({
      storeId,
      source: 'manual',
      sourceId: 'unit-test-1',
      memo: 'cash sale 1 KWD',
      lines: [
        { accountId: cashId, debit: 1000, credit: 0 },
        { accountId: revId, debit: 0, credit: 1000 },
      ],
    });
    expect(entry.status).toBe('posted');
    expect(entry.entryNumber).toMatch(/^JE-\d{4}-\d{6}$/);
  });

  it('refuses to post an unbalanced entry', async () => {
    await expect(
      postEntry({
        storeId,
        source: 'manual',
        sourceId: 'unit-test-bad',
        lines: [{ accountId: cashId, debit: 500, credit: 0 }],
      })
    ).rejects.toThrow(/unbalanced/i);
  });

  it('is idempotent on duplicate (source, sourceId)', async () => {
    const a = await postEntry({
      storeId,
      source: 'order',
      sourceId: 'order-99',
      lines: [
        { accountId: cashId, debit: 2000, credit: 0 },
        { accountId: revId, debit: 0, credit: 2000 },
      ],
    });
    const b = await postEntry({
      storeId,
      source: 'order',
      sourceId: 'order-99',
      lines: [
        // Different numbers — should still return the EXISTING entry, not insert a 2nd
        { accountId: cashId, debit: 9999, credit: 0 },
        { accountId: revId, debit: 0, credit: 9999 },
      ],
    });
    expect(b.id).toBe(a.id);
    const lines = await prisma.journalLine.findMany({ where: { entryId: a.id } });
    expect(lines.find(l => l.debit === 2000)).toBeDefined();
    expect(lines.find(l => l.debit === 9999)).toBeUndefined();
  });

  it('reverses an entry by creating a mirror entry', async () => {
    const a = await postEntry({
      storeId,
      source: 'manual',
      sourceId: 'rev-1',
      lines: [
        { accountId: cashId, debit: 3000, credit: 0 },
        { accountId: revId, debit: 0, credit: 3000 },
      ],
    });
    const r = await reverseEntry(a.id, 'test reversal');
    // reverses is the inverse accessor — load it explicitly via include
    const rWithInverse = await prisma.journalEntry.findUnique({
      where: { id: r.id },
      include: { reverses: true },
    });
    expect(rWithInverse?.reverses?.id).toBe(a.id);

    const updated = await prisma.journalEntry.findUnique({ where: { id: a.id } });
    expect(updated?.status).toBe('reversed');
    expect(updated?.reversedById).toBe(r.id);

    const revLines = await prisma.journalLine.findMany({ where: { entryId: r.id } });
    expect(revLines.find(l => l.credit === 3000 && l.accountId === cashId)).toBeDefined();
    expect(revLines.find(l => l.debit === 3000 && l.accountId === revId)).toBeDefined();
  });
});
