// N-9 / Ruling NZ-N9-6: readers of a DO-served store's customers go through the DO; a PG store is untouched; a suspended or
// deleted customer is never "live" (eligibility, pricing, email).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ onDo: new Set<string>(), calls: [] as unknown[] }));
vi.mock('../../apps/api/src/lib/customer-auth', () => ({
  customerAuthRoute: async (storeId: string) =>
    h.onDo.has(storeId)
      ? {
          kind: 'do',
          client: {
            call: async (_op: string, args: { ids: string[] }) => {
              h.calls.push(args.ids);
              return args.ids
                .filter(i => i !== 'ghost')
                .map(id => ({
                  id,
                  email: `${id}@x.com`,
                  firstName: 'F',
                  lastName: 'L',
                  phone: null,
                  status: id === 'sus' ? 'suspended' : 'active',
                  emailVerified: true,
                  language: 'en',
                  avatar: null,
                  createdAt: 1_700_000_000_000,
                  lastLoginAt: null,
                  deletedAt: id === 'del' ? 1_700_000_100_000 : null,
                }));
            },
          },
        }
      : { kind: 'pg' },
}));

import {
  customerRow,
  customerRows,
  isLiveCustomer,
  pickSelected,
} from '../../apps/api/src/lib/customer-directory';

beforeEach(() => {
  h.onDo = new Set(['S']);
  h.calls.length = 0;
});

describe('customer directory', () => {
  it('a store that is not DO-served returns null / undefined so the caller runs its Postgres query', async () => {
    expect(await customerRows('PG', ['a'])).toBeNull();
    expect(await customerRow('PG', 'a')).toBeUndefined();
    expect(await customerRow('PG', null)).toBeUndefined();
  });
  it('a DO store: rows from the DO, deduped, null for an unknown id', async () => {
    const rows = await customerRows('S', ['a', 'a', null, undefined, '']);
    expect(rows?.map(r => r.id)).toEqual(['a']);
    expect(h.calls).toEqual([['a']]);
    expect(await customerRow('S', 'ghost')).toBeNull();
    expect((await customerRow('S', 'a'))?.createdAt).toEqual(new Date(1_700_000_000_000));
  });
  it('suspended and deleted customers are not live; unknown is not live either', async () => {
    const rows = await customerRows('S', ['ok', 'sus', 'del']);
    expect(rows?.map(r => [r.id, isLiveCustomer(r)])).toEqual([
      ['ok', true],
      ['sus', false],
      ['del', false],
    ]);
  });
  it('batches large id lists (500 per DO call)', async () => {
    await customerRows(
      'S',
      Array.from({ length: 1100 }, (_, i) => `u${i}`)
    );
    expect(h.calls.map(c => (c as string[]).length)).toEqual([500, 500, 100]);
  });
  it('pickSelected returns the select shape plus id', async () => {
    const r = (await customerRow('S', 'a'))!;
    expect(pickSelected(r, { firstName: true, email: true, phone: false })).toEqual({
      id: 'a',
      firstName: 'F',
      email: 'a@x.com',
    });
  });
});
