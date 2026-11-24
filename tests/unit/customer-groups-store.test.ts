/** Ruling QA98-ALIAS-2: the group loader pages by KEYSET and is shared within a request; nothing here touches consent. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type O = { id: string; createdAt: number; shippingAddress: Record<string, string> };
const h = vi.hoisted(() => ({
  rows: [] as O[],
  scans: 0,
  onPage: null as null | (() => void),
  usedSkip: false,
}));

vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    order: {
      // newest first by (createdAt, id) desc, with prisma cursor semantics (the page starts AT the cursor row; skip:1 drops it)
      findMany: async (a: { take: number; cursor?: { id: string }; skip?: number }) => {
        h.scans += 1;
        if (a.skip && !a.cursor) h.usedSkip = true;
        const sorted = [...h.rows].sort((x, y) =>
          x.createdAt === y.createdAt ? (x.id < y.id ? 1 : -1) : y.createdAt - x.createdAt
        );
        let from = 0;
        if (a.cursor) from = sorted.findIndex(r => r.id === a.cursor!.id) + (a.skip ?? 0);
        const page = sorted.slice(from, from + a.take);
        h.onPage?.();
        return page.map(r => ({ id: r.id, shippingAddress: r.shippingAddress }));
      },
    },
  }),
}));

import { loadCustomerGroups } from '@api/lib/customer-groups-store';

const row = (n: number): O => ({
  id: `o${String(n).padStart(5, '0')}`,
  createdAt: n,
  shippingAddress: { email: `g${n}@x.test`, phone: `+2010${String(n).padStart(8, '0')}` },
});

beforeEach(() => {
  h.rows = [];
  h.scans = 0;
  h.onPage = null;
  h.usedSkip = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
});

describe('loadCustomerGroups', () => {
  it('pages by keyset: a guest order inserted while the scan runs makes it miss no member', async () => {
    h.rows = Array.from({ length: 1200 }, (_, i) => row(i + 1));
    let inserted = false;
    h.onPage = () => {
      if (!inserted) {
        inserted = true;
        h.rows.push(row(5000)); // the newest order arrives after page 1 was served
      }
    };
    const g = await loadCustomerGroups('store-keyset');
    // every one of the original 1200 guests is present (an offset scan would have skipped one at the page boundary)
    for (let i = 1; i <= 1200; i++)
      expect(g.groupOfMemberKey(`g${i}@x.test`), `g${i}`).not.toBeNull();
    expect(h.usedSkip).toBe(false);
    expect(h.scans).toBe(3);
  });

  it('is shared within a request: concurrent and repeated loads scan the store once', async () => {
    h.rows = [row(1), row(2)];
    const [a, b] = await Promise.all([
      loadCustomerGroups('store-memo'),
      loadCustomerGroups('store-memo'),
    ]);
    await loadCustomerGroups('store-memo');
    expect(a).toBe(b);
    expect(h.scans).toBe(1);
    vi.advanceTimersByTime(11_000);
    await loadCustomerGroups('store-memo');
    expect(h.scans).toBe(2);
  });
});
