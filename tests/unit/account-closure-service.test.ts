import { describe, it, expect, vi } from 'vitest';
vi.mock('@ebda/database', () => ({ withStore: vi.fn() }));
vi.mock('@api/lib/definer', () => ({ ownedStoreIds: vi.fn() }));

import { closeNonCustomerAccount, type ClosureDeps } from '@api/services/account-closure.service';

const done = (requestId: string) =>
  ({
    requestId,
    kind: 'merchant',
    subjectHash: 'h',
    startedAt: '',
    status: 'done',
    surfaces: [],
    errors: [],
  }) as never;

function deps(
  over: Partial<ClosureDeps> & { flag?: string; owned?: string[]; billed?: string[] } = {}
) {
  const run = vi.fn(async (_e: unknown, _s: unknown, subject: { requestId: string }) =>
    done(subject.requestId)
  );
  const recordRequest = vi.fn(async () => undefined);
  const d: ClosureDeps = {
    env: { PDPL_CF_ERASURE_ENABLED: over.flag },
    ownedStoreIds: async () => over.owned ?? [],
    liveBilledStoresOf: async () => over.billed ?? [],
    ownerSurfaces: () => [{ name: 'owner' } as never],
    staffSurfaces: () => [{ name: 'staff' } as never],
    recordRequest,
    run: run as never,
    ...over,
  };
  return { d, run, recordRequest };
}

describe('closeNonCustomerAccount (M-024)', () => {
  it('refuses an owner with a live billed store before anything runs (409, Arabic)', async () => {
    const { d, run, recordRequest } = deps({ flag: 'true', owned: ['s1'], billed: ['s1'] });
    await expect(closeNonCustomerAccount({ userId: 'u', requestId: 'r' }, d)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: 'OWNER_HAS_LIVE_BILLED_STORE',
      }
    );
    expect(run).not.toHaveBeenCalled();
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it('flag off: records the request, erases nothing', async () => {
    const { d, run, recordRequest } = deps({ flag: undefined, owned: ['s1'] });
    const out = await closeNonCustomerAccount({ userId: 'u', requestId: 'r' }, d);
    expect(out).toEqual({ status: 'recorded', stores: ['s1'] });
    expect(recordRequest).toHaveBeenCalledWith('u', 'r', ['s1']);
    expect(run).not.toHaveBeenCalled();
  });

  it('flag on: an owner runs the job once per store with a per-store request id', async () => {
    const { d, run } = deps({ flag: 'true', owned: ['s1', 's2'] });
    const out = await closeNonCustomerAccount({ userId: 'u', requestId: 'r' }, d);
    expect(out.status).toBe('erased');
    expect(
      run.mock.calls.map(c => (c[2] as { requestId: string; storeId: string }).requestId)
    ).toEqual(['r:s1', 'r:s2']);
    expect(run.mock.calls[0][1]).toEqual([{ name: 'owner' }]);
  });

  it('flag on: a staff user (no store) runs the identity surface only', async () => {
    const { d, run } = deps({ flag: 'true', owned: [] });
    await closeNonCustomerAccount({ userId: 'u', requestId: 'r' }, d);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual([{ name: 'staff' }]);
  });

  it('flag on: money in flight surfaces as 409 MONEY_IN_FLIGHT, not a success', async () => {
    const { d } = deps({ flag: 'true', owned: ['s1'] });
    d.run = (async () => ({
      ...(done('r:s1') as object),
      status: 'failed',
      surfaces: [
        {
          surface: 'store-do',
          erased: 0,
          remaining: 2,
          note: 'refused: money in flight (settle it, then retry)',
        },
      ],
    })) as never;
    await expect(closeNonCustomerAccount({ userId: 'u', requestId: 'r' }, d)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: 'MONEY_IN_FLIGHT',
      }
    );
  });
});
