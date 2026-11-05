/**
 * NEON-ZERO-1: `storeDb(id).store` for a Durable Object store. The DO serves profile + config in one RPC; D1-only columns
 * come from the platform client only when selected; relations / include / foreign ids are refused or null, never Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeRpc, decodeRpc } from '@ebda-src/repo';

const d1Reads: unknown[] = [];
vi.mock('../../apps/api/src/lib/platform-db', () => ({
  requirePlatformDb: async () => ({
    store: {
      findUnique: async (a: unknown) => {
        d1Reads.push(a);
        return { deletedAt: null, billingSuspendedReason: 'unpaid' };
      },
    },
  }),
}));

import { doStoreDelegate } from '../../apps/api/src/lib/repo-factory';

const S = 'store-1';
const REC = { id: S, name: 'Shop', status: 'active', taxEnabled: true, theme: { a: 1 } };
function stub(missing: string[] = [], code?: string) {
  const calls: Array<{ storeId: string; fields?: string[] }> = [];
  return {
    calls,
    storeRecord: async (storeId: string, fields?: string[]) => {
      calls.push({ storeId, fields });
      if (code) return { ok: false as const, code };
      const rec = fields
        ? Object.fromEntries(fields.filter(f => f in REC).map(f => [f, (REC as never)[f]]))
        : REC;
      return { ok: true as const, data: { json: encodeRpc(rec), missing } };
    },
  };
}
const make = (st: ReturnType<typeof stub>) => doStoreDelegate(S, st as never, decodeRpc as never);

describe('doStoreDelegate', () => {
  it('serves a select from ONE DO call and projects exactly the selected fields', async () => {
    const st = stub();
    const row = await make(st).findUnique({
      where: { id: S },
      select: { name: true, theme: true },
    });
    expect(row).toEqual({ name: 'Shop', theme: { a: 1 } });
    expect(st.calls).toEqual([{ storeId: S, fields: ['name', 'theme'] }]);
    expect(d1Reads).toHaveLength(0);
  });
  it('reads D1-only columns from the platform client only when selected', async () => {
    const st = stub(['deletedAt', 'billingSuspendedReason']);
    const row = await make(st).findUnique({
      where: { id: S },
      select: { name: true, deletedAt: true, billingSuspendedReason: true },
    });
    expect(row).toEqual({ name: 'Shop', deletedAt: null, billingSuspendedReason: 'unpaid' });
    expect(d1Reads).toEqual([
      { where: { id: S }, select: { deletedAt: true, billingSuspendedReason: true } },
    ]);
  });
  it('applies scalar filters in memory (equality, in, not) and returns null on a mismatch', async () => {
    const d = make(stub());
    expect(await d.findFirst({ where: { id: S, status: 'active' }, select: { id: true } })).toEqual(
      { id: S }
    );
    expect(
      await d.findFirst({ where: { id: S, status: { in: ['suspended'] } }, select: { id: true } })
    ).toBeNull();
    expect(
      await d.findFirst({ where: { id: S, status: { not: 'active' } }, select: { id: true } })
    ).toBeNull();
  });
  it('another store id is null without any DO call; findUniqueOrThrow is a 404', async () => {
    const st = stub();
    const d = make(st);
    expect(await d.findUnique({ where: { id: 'other' }, select: { id: true } })).toBeNull();
    expect(st.calls).toHaveLength(0);
    await expect(d.findUniqueOrThrow({ where: { id: 'other' } })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
  it('include and unknown filter shapes are refused loudly (501), a missing profile is null', async () => {
    const d = make(stub());
    await expect(
      d.findUnique({ where: { id: S }, include: { owner: true } })
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      d.findFirst({ where: { id: S, name: { contains: 'x' } }, select: { id: true } })
    ).rejects.toMatchObject({ statusCode: 501 });
    expect(
      await make(stub([], 'STORE_NOT_FOUND')).findUnique({ where: { id: S }, select: { id: true } })
    ).toBeNull();
  });
});
