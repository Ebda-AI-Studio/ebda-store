/**
 * SELF-SERVICE gap A11 (Task 5, store-lifecycle): an OWNER deletes their own store behind a confirm token + typed slug and a
 * 14-day cooling-off they can cancel, and exports every row of their store. Staff, other stores and replays are refused;
 * super_admin `DELETE /stores/:id` stays (support / test stores).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@api/config', () => ({
  config: { encryptionKey: 'test-encryption-key-0123456789abcdef' },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: () => false, getClient: () => null },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  previewStoreDeletion,
  scheduleStoreDeletion,
  cancelStoreDeletion,
  executeStoreDeletion,
  readDeletionStatus,
  type DeletionDeps,
  type DeletionRequest,
} from '@api/services/store-deletion.service';

const COOLING_OFF_MS = 14 * 86_400_000;
type DeletionStore = NonNullable<Awaited<ReturnType<DeletionDeps['loadStore']>>>;
const NOW = Date.parse('2026-11-14T10:00:00Z');
const OWNER = 'owner-1';

function makeDeps(over: Partial<DeletionDeps> = {}, store?: Partial<DeletionStore>) {
  const state: { store: DeletionStore } = {
    store: {
      id: 'store-a',
      name: 'Shop A',
      slug: 'shop-a',
      ownerId: OWNER,
      deletionRequest: null,
      ...store,
    },
  };
  let now = NOW;
  let deleted = false;
  const deps = {
    now: () => now,
    loadStore: vi.fn(async (id: string) =>
      id === state.store.id && !deleted ? { ...state.store } : null
    ),
    saveRequest: vi.fn(async (_id: string, r: DeletionRequest | null) => {
      state.store.deletionRequest = r;
    }),
    transition: vi.fn(
      async (_id: string, from: { id: string; state: string }, to: DeletionRequest) => {
        const cur = state.store.deletionRequest;
        if (!cur || cur.id !== from.id || cur.state !== from.state) return false;
        state.store.deletionRequest = to;
        return true;
      }
    ),
    moneyInFlight: vi.fn(async () => null as Record<string, number> | null),
    hasBilledSubscription: vi.fn(async () => false),
    isBillingParentWithSiblings: vi.fn(async () => false),
    deleteStore: vi.fn(async () => {
      deleted = true;
    }),
    audit: vi.fn(async () => undefined),
    emit: vi.fn(async () => undefined),
    notifyOwner: vi.fn(async () => undefined),
    alertStuck: vi.fn(async () => undefined),
    ...over,
  } satisfies DeletionDeps;
  return {
    deps,
    state,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function mintToken(deps: DeletionDeps, userId = OWNER, storeId = 'store-a') {
  const p = await previewStoreDeletion({ storeId, userId }, deps);
  if (!p.ok) throw new Error('preview refused');
  return p.confirmToken;
}

describe('preview (guards with named reasons)', () => {
  it('owner of a clean store gets a token and the slug to type', async () => {
    const { deps } = makeDeps();
    const p = await previewStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.slug).toBe('shop-a');
      expect(p.coolingOffDays).toBe(14);
      expect(p.confirmToken).toMatch(/\./);
    }
  });
  it('refuses with a named reason when money is in flight', async () => {
    const { deps } = makeDeps({ moneyInFlight: vi.fn(async () => ({ paidUndelivered: 2 })) });
    const p = await previewStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons.map(r => r.code)).toEqual(['STORE_HAS_MONEY_IN_FLIGHT']);
  });
  it('refuses while the store subscription is still billed', async () => {
    const { deps } = makeDeps({ hasBilledSubscription: vi.fn(async () => true) });
    const p = await previewStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons.map(r => r.code)).toEqual(['STORE_HAS_BILLED_SUBSCRIPTION']);
  });
  it('refuses the billing parent while the owner has other stores', async () => {
    const { deps } = makeDeps({ isBillingParentWithSiblings: vi.fn(async () => true) });
    const p = await previewStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons.map(r => r.code)).toEqual(['STORE_IS_BILLING_PARENT']);
  });
  it('a staff member (not the owner) gets 403', async () => {
    const { deps } = makeDeps();
    await expect(
      previewStoreDeletion({ storeId: 'store-a', userId: 'staff-9' }, deps)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('an unknown store is a 404', async () => {
    const { deps } = makeDeps();
    await expect(
      previewStoreDeletion({ storeId: 'nope', userId: OWNER }, deps)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('schedule (confirm token + typed slug + 14-day cooling-off)', () => {
  it('schedules a pending request 14 days out, audits, emits and notifies once', async () => {
    const { deps, state } = makeDeps();
    const token = await mintToken(deps);
    const r = await scheduleStoreDeletion(
      { storeId: 'store-a', userId: OWNER, confirmToken: token, typedSlug: 'shop-a' },
      deps
    );
    expect(r.state).toBe('pending');
    expect(Date.parse(r.executeAfter) - NOW).toBe(COOLING_OFF_MS);
    expect(state.store.deletionRequest?.state).toBe('pending');
    expect(deps.deleteStore).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_SCHEDULED' })
    );
    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect(deps.notifyOwner).toHaveBeenCalledTimes(1);
  });
  it('refuses a wrong typed slug and does not burn the token', async () => {
    const { deps } = makeDeps();
    const token = await mintToken(deps);
    await expect(
      scheduleStoreDeletion(
        { storeId: 'store-a', userId: OWNER, confirmToken: token, typedSlug: 'shop-b' },
        deps
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'SLUG_MISMATCH' });
    const ok = await scheduleStoreDeletion(
      { storeId: 'store-a', userId: OWNER, confirmToken: token, typedSlug: 'shop-a' },
      deps
    );
    expect(ok.state).toBe('pending');
  });
  it('refuses a replayed token', async () => {
    const { deps } = makeDeps();
    const token = await mintToken(deps);
    const input = { storeId: 'store-a', userId: OWNER, confirmToken: token, typedSlug: 'shop-a' };
    await scheduleStoreDeletion(input, deps);
    await cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    await expect(scheduleStoreDeletion(input, deps)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CONFIRM_TOKEN_INVALID',
    });
  });
  it('refuses a garbage token and a token minted for another user', async () => {
    const { deps } = makeDeps();
    await expect(
      scheduleStoreDeletion(
        { storeId: 'store-a', userId: OWNER, confirmToken: 'x.y', typedSlug: 'shop-a' },
        deps
      )
    ).rejects.toMatchObject({ code: 'CONFIRM_TOKEN_INVALID' });
    const t = await mintToken(deps);
    const other = makeDeps({}, { ownerId: 'owner-2' });
    await expect(
      scheduleStoreDeletion(
        { storeId: 'store-a', userId: 'owner-2', confirmToken: t, typedSlug: 'shop-a' },
        other.deps
      )
    ).rejects.toMatchObject({ code: 'CONFIRM_TOKEN_INVALID' });
  });
  it('re-checks the guards at schedule time (money arrived after the preview)', async () => {
    const m = vi.fn(async () => null as Record<string, number> | null);
    const { deps } = makeDeps({ moneyInFlight: m });
    const token = await mintToken(deps);
    m.mockResolvedValue({ openReturns: 1 });
    await expect(
      scheduleStoreDeletion(
        { storeId: 'store-a', userId: OWNER, confirmToken: token, typedSlug: 'shop-a' },
        deps
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'STORE_HAS_MONEY_IN_FLIGHT' });
    expect(deps.saveRequest).not.toHaveBeenCalled();
  });
  it('a staff member cannot schedule', async () => {
    const { deps } = makeDeps();
    const token = await mintToken(deps);
    await expect(
      scheduleStoreDeletion(
        { storeId: 'store-a', userId: 'staff-9', confirmToken: token, typedSlug: 'shop-a' },
        deps
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('a second request while one is pending is a 409', async () => {
    const { deps } = makeDeps();
    await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(deps),
        typedSlug: 'shop-a',
      },
      deps
    );
    await expect(
      scheduleStoreDeletion(
        {
          storeId: 'store-a',
          userId: OWNER,
          confirmToken: await mintToken(deps),
          typedSlug: 'shop-a',
        },
        deps
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'DELETION_ALREADY_SCHEDULED' });
  });
});

describe('cancel', () => {
  it('owner cancels inside the cooling-off; a second cancel is 409', async () => {
    const { deps, state } = makeDeps();
    await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(deps),
        typedSlug: 'shop-a',
      },
      deps
    );
    const r = await cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    expect(r.state).toBe('cancelled');
    expect(state.store.deletionRequest?.state).toBe('cancelled');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_CANCELLED' })
    );
    await expect(
      cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps)
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it('staff cannot cancel', async () => {
    const { deps } = makeDeps();
    await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(deps),
        typedSlug: 'shop-a',
      },
      deps
    );
    await expect(
      cancelStoreDeletion({ storeId: 'store-a', userId: 'staff-9' }, deps)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('status read is owner-only', async () => {
    const { deps } = makeDeps();
    await expect(
      readDeletionStatus({ storeId: 'store-a', userId: 'staff-9' }, deps)
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('execute (after the cooling-off)', () => {
  async function scheduled() {
    const h = makeDeps();
    const r = await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(h.deps),
        typedSlug: 'shop-a',
      },
      h.deps
    );
    return { ...h, r };
  }
  it('does nothing before executeAfter', async () => {
    const { deps, r } = await scheduled();
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, deps);
    expect(o.outcome).toBe('not-due');
    expect(deps.deleteStore).not.toHaveBeenCalled();
  });
  it('deletes exactly once after the window; a second run is a no-op', async () => {
    const { deps, advance, r } = await scheduled();
    advance(COOLING_OFF_MS + 1);
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, deps)).outcome
    ).toBe('executed');
    expect(deps.deleteStore).toHaveBeenCalledTimes(1);
    expect(deps.deleteStore).toHaveBeenCalledWith('store-a', OWNER);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETED_BY_OWNER' })
    );
    const again = await executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, deps);
    expect(again.outcome).toBe('gone');
    expect(deps.deleteStore).toHaveBeenCalledTimes(1);
  });
  it('a cancelled request is never executed', async () => {
    const { deps, advance, r } = await scheduled();
    await cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, deps);
    advance(COOLING_OFF_MS + 1);
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, deps)).outcome
    ).toBe('cancelled');
    expect(deps.deleteStore).not.toHaveBeenCalled();
  });
  it('a stale request id (an older cancelled one) never deletes the newer request', async () => {
    const { deps, advance, r } = await scheduled();
    advance(COOLING_OFF_MS + 1);
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: 'some-other-id' }, deps);
    expect(o.outcome).toBe('stale');
    expect(r.id).not.toBe('some-other-id');
    expect(deps.deleteStore).not.toHaveBeenCalled();
  });
  it('a guard that flipped during the window blocks the delete and keeps the request pending', async () => {
    const m = vi.fn(async () => null as Record<string, number> | null);
    const h = makeDeps({ moneyInFlight: m });
    const r = await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(h.deps),
        typedSlug: 'shop-a',
      },
      h.deps
    );
    h.advance(COOLING_OFF_MS + 1);
    m.mockResolvedValue({ paidUndelivered: 1 });
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, h.deps);
    expect(o.outcome).toBe('blocked');
    expect(h.deps.deleteStore).not.toHaveBeenCalled();
    expect(h.state.store.deletionRequest?.state).toBe('pending');
    expect(h.state.store.deletionRequest?.lastBlock?.code).toBe('STORE_HAS_MONEY_IN_FLIGHT');
    m.mockResolvedValue(null);
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, h.deps)).outcome
    ).toBe('executed');
  });
  it('a delete that throws leaves the request executing (the retry resumes and converges)', async () => {
    const del = vi.fn(async () => {
      throw new Error('boom');
    });
    const h = makeDeps({ deleteStore: del });
    const r = await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(h.deps),
        typedSlug: 'shop-a',
      },
      h.deps
    );
    h.advance(COOLING_OFF_MS + 1);
    await expect(
      executeStoreDeletion({ storeId: 'store-a', requestId: r.id }, h.deps)
    ).rejects.toThrow('boom');
    expect(h.state.store.deletionRequest?.state).toBe('executing');
  });
});

describe('super_admin override stays', () => {
  it('DELETE /stores/:id is still super_admin only (support and test stores, no cooling-off)', () => {
    const src = readFileSync(
      path.join(__dirname, '../../apps/api/src/routes/store.routes.ts'),
      'utf8'
    );
    const at = src.indexOf("router.delete(\n  '/:id',");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("authorize('super_admin')");
  });
});

describe('deletionRequest is a server-owned settings key', () => {
  it('a generic settings write can neither plant nor revert it', async () => {
    const { reservedSettingsKeys, mergeClientSettings } = await import('@ebda/shared');
    expect(reservedSettingsKeys({ deletionRequest: { state: 'cancelled' } })).toContain(
      'deletionRequest'
    );
    const kept = mergeClientSettings(
      { deletionRequest: { state: 'pending' } },
      { deletionRequest: { state: 'cancelled' }, other: 1 }
    );
    expect(kept.deletionRequest).toEqual({ state: 'pending' });
    expect(
      mergeClientSettings({}, { deletionRequest: { state: 'pending' } }).deletionRequest
    ).toBeUndefined();
  });
});

import { AppError } from '@api/middleware/error-handler';

describe('review findings (Opus review of #772)', () => {
  async function scheduledStore(over: Partial<DeletionDeps> = {}) {
    const h = makeDeps(over);
    const r = await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(h.deps),
        typedSlug: 'shop-a',
      },
      h.deps
    );
    h.advance(COOLING_OFF_MS + 1);
    return { ...h, r };
  }
  const moneyError = () =>
    new AppError(409, 'STORE_HAS_MONEY_IN_FLIGHT', 'money in flight', {
      paidUndelivered: 1,
    } as never);

  it('F1: a money-in-flight 409 from the delete (Durable Object store) is BLOCKED, visible, audited, and the request stays pending', async () => {
    const del = vi.fn(async () => {
      throw moneyError();
    });
    const h = await scheduledStore({ deleteStore: del });
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('blocked');
    expect(h.state.store.deletionRequest?.state).toBe('pending');
    expect(h.state.store.deletionRequest?.lastBlock?.code).toBe('STORE_HAS_MONEY_IN_FLIGHT');
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_BLOCKED' })
    );
    // later the money settles: the next daily run deletes
    del.mockImplementation(async () => undefined);
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps)).outcome
    ).toBe('executed');
  });

  it('F2: ownership transferred during the window voids the request; the new owner loses nothing', async () => {
    const h = await scheduledStore();
    h.state.store.ownerId = 'owner-B';
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('voided');
    expect(h.deps.deleteStore).not.toHaveBeenCalled();
    expect(h.state.store.deletionRequest?.state).toBe('cancelled');
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_VOIDED_OWNER_CHANGED' })
    );
    expect(h.deps.notifyOwner).toHaveBeenCalledWith('cancelled', expect.anything());
  });

  it('F3: a cancel that wins the compare-and-set before the claim stops the delete; a cancel during executing is refused', async () => {
    const h = await scheduledStore();
    // cancel lands after execute read `pending` but before it claims: the claim loses
    const realTransition = h.deps.transition;
    h.deps.transition = vi.fn(async (id, from, to) => {
      if (from.state === 'pending' && to.state === 'executing') {
        await cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, h.deps);
      }
      return realTransition(id, from, to);
    });
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('cancelled');
    expect(h.deps.deleteStore).not.toHaveBeenCalled();
  });
  it('F3: cancel is refused while the deletion is executing', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const h = await scheduledStore({
      deleteStore: vi.fn(async () => {
        await gate;
      }),
    });
    const running = executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    await vi.waitFor(() => expect(h.state.store.deletionRequest?.state).toBe('executing'));
    await expect(
      cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, h.deps)
    ).rejects.toMatchObject({ statusCode: 409, code: 'DELETION_IN_PROGRESS' });
    release();
    expect((await running).outcome).toBe('executed');
  });
  it('F3: a cancel whose compare-and-set loses (the executor claimed first) is refused, not silently dropped', async () => {
    const h = await scheduledStore();
    h.deps.transition = vi.fn(async () => false);
    await expect(
      cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, h.deps)
    ).rejects.toMatchObject({ statusCode: 409, code: 'DELETION_IN_PROGRESS' });
    expect(h.deps.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_CANCELLED' })
    );
  });
  it('F3: a crash mid-delete leaves `executing`; the retry resumes it and converges', async () => {
    const del = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const h = await scheduledStore({ deleteStore: del });
    await expect(
      executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps)
    ).rejects.toThrow('boom');
    expect(['pending', 'executing']).toContain(h.state.store.deletionRequest?.state);
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps)).outcome
    ).toBe('executed');
  });

  it('F4: super_admin can read and cancel an owner pending deletion (audited); staff still cannot', async () => {
    const h = await scheduledStore();
    const st = await readDeletionStatus(
      { storeId: 'store-a', userId: 'root-1', role: 'super_admin' },
      h.deps
    );
    expect(st.request?.state).toBe('pending');
    expect(st.isOwner).toBe(false);
    const c = await cancelStoreDeletion(
      { storeId: 'store-a', userId: 'root-1', role: 'super_admin' },
      h.deps
    );
    expect(c.state).toBe('cancelled');
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STORE_DELETION_CANCELLED',
        userId: 'root-1',
        details: expect.objectContaining({ byRole: 'super_admin' }),
      })
    );
    await expect(
      readDeletionStatus({ storeId: 'store-a', userId: 'staff-9', role: 'store_admin' }, h.deps)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('F4: super_admin still cannot SCHEDULE or preview for a store they do not own', async () => {
    const h = makeDeps();
    await expect(
      previewStoreDeletion(
        { storeId: 'store-a', userId: 'root-1', role: 'super_admin' } as never,
        h.deps
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('stuck executing (follow-up to #772): repeated non-money failures are visible and alert, never a silent loop', () => {
  async function scheduledWith(over: Partial<DeletionDeps>) {
    const h = makeDeps(over);
    const r = await scheduleStoreDeletion(
      {
        storeId: 'store-a',
        userId: OWNER,
        confirmToken: await mintToken(h.deps),
        typedSlug: 'shop-a',
      },
      h.deps
    );
    h.advance(COOLING_OFF_MS + 1);
    return { ...h, r };
  }
  const run = (h: { deps: DeletionDeps; r: DeletionRequest }) =>
    executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);

  it('counts each failure with its reason and rethrows until the limit; the 3rd failure returns STUCK, audits and raises ONE P1', async () => {
    const del = vi.fn(async () => {
      throw new Error('r2 timeout');
    });
    const h = await scheduledWith({ deleteStore: del });
    await expect(run(h)).rejects.toThrow('r2 timeout');
    expect(h.state.store.deletionRequest?.failures).toBe(1);
    await expect(run(h)).rejects.toThrow('r2 timeout');
    expect(h.state.store.deletionRequest?.failures).toBe(2);
    expect((await run(h)).outcome).toBe('stuck');
    const req = h.state.store.deletionRequest!;
    expect(req.state).toBe('executing');
    expect(req.stuckAt).toBeTruthy();
    expect(req.lastFailure?.message).toContain('r2 timeout');
    expect(h.deps.alertStuck).toHaveBeenCalledTimes(1);
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_STUCK' })
    );
  });

  it('once stuck it does NOT call the delete again (no silent loop) and does not alert again', async () => {
    const del = vi.fn(async () => {
      throw new Error('boom');
    });
    const h = await scheduledWith({ deleteStore: del });
    await expect(run(h)).rejects.toThrow();
    await expect(run(h)).rejects.toThrow();
    await run(h);
    const calls = del.mock.calls.length;
    expect((await run(h)).outcome).toBe('stuck');
    expect((await run(h)).outcome).toBe('stuck');
    expect(del.mock.calls.length).toBe(calls);
    expect(h.deps.alertStuck).toHaveBeenCalledTimes(1);
  });

  it('super_admin sees the stuck state, count and reason', async () => {
    const h = await scheduledWith({
      deleteStore: vi.fn(async () => {
        throw new Error('d1 down');
      }),
    });
    await expect(run(h)).rejects.toThrow();
    await expect(run(h)).rejects.toThrow();
    await run(h);
    const st = await readDeletionStatus(
      { storeId: 'store-a', userId: 'root-1', role: 'super_admin' },
      h.deps
    );
    expect(st.request).toMatchObject({ state: 'executing', failures: 3 });
    expect(st.request?.stuckAt).toBeTruthy();
    expect(st.request?.lastFailure?.message).toContain('d1 down');
  });

  it('a money block is not a failure: it does not count toward stuck', async () => {
    const del = vi.fn(async () => {
      throw new AppError(409, 'STORE_HAS_MONEY_IN_FLIGHT', 'money', {
        paidUndelivered: 1,
      } as never);
    });
    const h = await scheduledWith({ deleteStore: del });
    for (let i = 0; i < 5; i++) expect((await run(h)).outcome).toBe('blocked');
    expect(h.state.store.deletionRequest?.failures ?? 0).toBe(0);
    expect(h.deps.alertStuck).not.toHaveBeenCalled();
  });

  it('a success after earlier failures still executes', async () => {
    const del = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);
    const h = await scheduledWith({ deleteStore: del });
    await expect(run(h)).rejects.toThrow('blip');
    expect((await run(h)).outcome).toBe('executed');
    expect(h.deps.alertStuck).not.toHaveBeenCalled();
  });
});
