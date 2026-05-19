import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { nextSequence } from '../../../apps/api/src/services/sequence.service';

const OWNER_ID = '00000000-0000-0000-0000-0000000000aa';
let STORE: string;

beforeAll(async () => {
  // Ensure the owner user exists (Store FK → User)
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: 'seq-test-owner@force-test.internal',
      passwordHash: 'not-a-real-hash',
      firstName: 'Seq',
      lastName: 'Test',
      role: 'store_admin',
    },
  });

  // Sequence FK to Store(Cascade) requires a real store
  const ts = Date.now();
  const s = await prisma.store.create({
    data: {
      name: `seq-test-${ts}`,
      slug: `seq-test-${ts}`,
      ownerId: OWNER_ID,
    },
  });
  STORE = s.id;
});

afterAll(async () => {
  await prisma.sequence.deleteMany({ where: { storeId: STORE } });
  await prisma.store.delete({ where: { id: STORE } });
  // leave the user — it's a stable fixture; other tests may reuse it
});

beforeEach(async () => {
  await prisma.sequence.deleteMany({ where: { storeId: STORE } });
});

describe('sequence.service', () => {
  it('returns 1 on first call per (store, kind) and increments atomically', async () => {
    const first = await nextSequence(STORE, 'journal');
    const second = await nextSequence(STORE, 'journal');
    expect(first).toBe(`JE-${new Date().getUTCFullYear()}-000001`);
    expect(second).toBe(`JE-${new Date().getUTCFullYear()}-000002`);
  });

  it('isolates counters by kind', async () => {
    await nextSequence(STORE, 'journal');
    const po = await nextSequence(STORE, 'po');
    expect(po).toBe(`PO-${new Date().getUTCFullYear()}-000001`);
  });

  it('survives concurrent calls without dupes', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => nextSequence(STORE, 'journal'))
    );
    expect(new Set(results).size).toBe(20);
  });

  it('throws on unknown kind', async () => {
    await expect(nextSequence(STORE, 'unknown' as any)).rejects.toThrow(/Unknown sequence kind/);
  });
});
