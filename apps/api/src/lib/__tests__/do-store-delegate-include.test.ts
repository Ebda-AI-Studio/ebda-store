import { describe, it, expect, vi } from 'vitest';

vi.mock('../identity-client', () => ({
  getAccountState: vi.fn(async (id: string) =>
    id === 'u1'
      ? { id: 'u1', email: 'o@x.test', firstName: 'O', lastName: 'W', status: 'active' }
      : null
  ),
}));

const d1Store = {
  findUnique: vi.fn(async (args: { select: Record<string, boolean> }) =>
    Object.fromEntries(
      Object.keys(args.select).map(k => [
        k,
        k === 'pendingDomain' ? 'ameliaaurum.com' : k === 'domainStatus' ? 'pending' : null,
      ])
    )
  ),
};
vi.mock('../platform-db', () => ({
  platformDb: () => ({ store: d1Store }),
  requirePlatformDb: async () => ({ store: d1Store }),
}));

import { doStoreDelegate } from '../repo-factory';

const record = { id: 's1', name: 'QA', slug: 'qa', ownerId: 'u1', status: 'inactive' };
const stub = () => ({
  storeRecord: vi.fn(async () => ({
    ok: true as const,
    data: { json: JSON.stringify(record), missing: [] as string[] },
  })),
});
const delegate = (s = stub()) =>
  doStoreDelegate('s1', s as never, ((t: string) => JSON.parse(t)) as never);

describe('doStoreDelegate include (GET/PUT /stores/:id 501 STORE_READ_UNSUPPORTED)', () => {
  it('serves include: { owner: { select } } as every scalar + the projected owner', async () => {
    const row = await delegate().findUnique({
      where: { id: 's1' },
      include: { owner: { select: { id: true, email: true } } },
    });
    expect(row).toMatchObject({ id: 's1', name: 'QA', slug: 'qa', ownerId: 'u1' });
    expect(row.owner).toEqual({ id: 'u1', email: 'o@x.test' });
  });

  it('serves include: { owner: true } with the full public account shape', async () => {
    const row = await delegate().findUnique({ where: { id: 's1' }, include: { owner: true } });
    expect(row.owner).toEqual({ id: 'u1', email: 'o@x.test', firstName: 'O', lastName: 'W' });
  });

  it('still refuses any other relation include loudly', async () => {
    await expect(
      delegate().findUnique({ where: { id: 's1' }, include: { products: true } })
    ).rejects.toMatchObject({ code: 'STORE_READ_UNSUPPORTED' });
  });

  it('another store id is null, never a read', async () => {
    const s = stub();
    expect(
      await delegate(s).findUnique({ where: { id: 'other' }, include: { owner: true } })
    ).toBeNull();
    expect(s.storeRecord).not.toHaveBeenCalled();
  });

  it('a whole-record read carries the D1-only columns (pending domain claim survives GET /stores/:id)', async () => {
    const row = await delegate().findUnique({ where: { id: 's1' }, include: { owner: true } });
    expect(row.pendingDomain).toBe('ameliaaurum.com');
    expect(row.domainStatus).toBe('pending');
  });

  it('a narrow select does not pay the extra D1 read', async () => {
    d1Store.findUnique.mockClear();
    await delegate().findUnique({ where: { id: 's1' }, select: { id: true, name: true } });
    expect(d1Store.findUnique).not.toHaveBeenCalled();
  });
});
