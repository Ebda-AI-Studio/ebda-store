import { describe, it, expect, vi } from 'vitest';

vi.mock('../identity-client', () => ({
  getAccountState: vi.fn(async (id: string) =>
    id === 'u1'
      ? { id: 'u1', email: 'o@x.test', firstName: 'O', lastName: 'W', status: 'active' }
      : null
  ),
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
});
