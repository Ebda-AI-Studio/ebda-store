// Ruling NZ-C-11: admin push audiences from D1 + identity (no Postgres).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { d1All, getAccountsBrief } = vi.hoisted(() => ({
  d1All: vi.fn(),
  getAccountsBrief: vi.fn(),
}));
vi.mock('../../apps/api/src/services/platform/billing-d1', () => ({ d1All }));
vi.mock('../../apps/api/src/lib/identity-client', () => ({ getAccountsBrief }));

import {
  adminPushPlayerIdsD1,
  DEVICE_SCAN_CAP,
} from '../../apps/api/src/services/platform/push-d1';

const brief = (id: string, role: string) => ({ id, role });
beforeEach(() => {
  d1All.mockReset();
  getAccountsBrief.mockReset();
});

describe('adminPushPlayerIdsD1', () => {
  it('store_admin: the store owner devices, role-checked, deduped', async () => {
    d1All.mockResolvedValue([
      { user_id: 'o1', player_id: 'p1' },
      { user_id: 'o1', player_id: 'p1' },
    ]);
    getAccountsBrief.mockResolvedValue([brief('o1', 'store_admin')]);
    expect(await adminPushPlayerIdsD1('store_admin', 's1')).toEqual(['p1']);
    expect(d1All.mock.calls[0].slice(1)).toEqual(['s1', DEVICE_SCAN_CAP]);
  });
  it('store_admin without a store -> nothing, no query', async () => {
    expect(await adminPushPlayerIdsD1('store_admin', null)).toEqual([]);
    expect(d1All).not.toHaveBeenCalled();
  });
  it('super_admin: keeps only super_admin accounts, bounded scan', async () => {
    d1All.mockResolvedValue([
      { user_id: 'a', player_id: 'pa' },
      { user_id: 'b', player_id: 'pb' },
    ]);
    getAccountsBrief.mockResolvedValue([brief('a', 'super_admin'), brief('b', 'staff')]);
    expect(await adminPushPlayerIdsD1('super_admin', null)).toEqual(['pa']);
    expect(d1All.mock.calls[0][1]).toBe(DEVICE_SCAN_CAP);
  });
  it('no devices -> no identity call', async () => {
    d1All.mockResolvedValue([]);
    expect(await adminPushPlayerIdsD1('super_admin', null)).toEqual([]);
    expect(getAccountsBrief).not.toHaveBeenCalled();
  });
});
