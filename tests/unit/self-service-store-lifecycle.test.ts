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
  const markers = new Map<string, unknown>();
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
    isOnDo: vi.fn(async () => false),
    marker: {
      write: vi.fn(async (id: string, m: unknown) => void markers.set(id, m)),
      read: vi.fn(async (id: string) => (markers.get(id) ?? null) as never),
      clear: vi.fn(async (id: string) => void markers.delete(id)),
    },
    finishDeletedStore: vi.fn(async () => undefined),
    erasureBlocked: vi.fn(async () => false),
    ownerEmail: vi.fn(async () => 'owner@example.com' as string | null),
    audit: vi.fn(async () => undefined),
    emit: vi.fn(async () => undefined),
    notifyOwner: vi.fn(async () => undefined),
    ...over,
  } satisfies DeletionDeps;
  return {
    deps,
    state,
    markers,
    markDeleted: () => {
      deleted = true;
    },
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
    expect(deps.deleteStore).toHaveBeenCalledWith('store-a', OWNER, r.id);
    // m1: the owner is told the store was deleted, on the address the identity service holds
    expect(deps.notifyOwner).toHaveBeenCalledWith(
      'executed',
      expect.objectContaining({ to: 'owner@example.com', slug: 'shop-a' })
    );
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
    // m1: the requester is emailed that the request was voided (not silently dropped)
    expect(h.deps.notifyOwner).toHaveBeenCalledWith(
      'voided',
      expect.objectContaining({ to: 'owner@example.com' })
    );
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

describe('blocker fixes (re-review of #772)', () => {
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

  it('C2: FISCAL_ARCHIVE_FAILED (503) from the delete is a BLOCK, not a job failure', async () => {
    const del = vi.fn(async () => {
      throw new AppError(503, 'FISCAL_ARCHIVE_FAILED', 'archive failed');
    });
    const h = await scheduledStore({ deleteStore: del });
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('blocked');
    expect(h.state.store.deletionRequest?.state).toBe('pending');
    expect(h.state.store.deletionRequest?.lastBlock?.code).toBe('FISCAL_ARCHIVE_FAILED');
  });

  it('C2: recoverFailedExecution puts a stuck `executing` request back to pending with the reason; a moved-on request is left alone', async () => {
    const del = vi.fn(async () => {
      throw new Error('boom');
    });
    const h = await scheduledStore({ deleteStore: del });
    await expect(
      executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps)
    ).rejects.toThrow('boom');
    expect(h.state.store.deletionRequest?.state).toBe('executing');
    const { recoverFailedExecution } = await import('@api/services/store-deletion.service');
    expect(
      await recoverFailedExecution(
        { storeId: 'store-a', requestId: h.r.id, reason: 'boom' },
        h.deps
      )
    ).toMatchObject({ recovered: true });
    expect(h.state.store.deletionRequest).toMatchObject({
      state: 'pending',
      lastBlock: { code: 'EXECUTION_FAILED', reason: 'boom' },
    });
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETION_EXECUTION_FAILED' })
    );
    // pending again: nothing to recover, and the owner can cancel
    expect(
      await recoverFailedExecution({ storeId: 'store-a', requestId: h.r.id, reason: 'x' }, h.deps)
    ).toMatchObject({ recovered: false });
    expect((await cancelStoreDeletion({ storeId: 'store-a', userId: OWNER }, h.deps)).state).toBe(
      'cancelled'
    );
  });

  it('M4: the event is sent BEFORE the request is saved, so a failed send leaves nothing pending and the retry is not a 409', async () => {
    const emit = vi.fn(async () => {
      throw new Error('inngest down');
    });
    const h = makeDeps({ emit });
    const input = async () => ({
      storeId: 'store-a',
      userId: OWNER,
      confirmToken: await mintToken(h.deps),
      typedSlug: 'shop-a',
    });
    await expect(scheduleStoreDeletion(await input(), h.deps)).rejects.toThrow('inngest down');
    expect(h.state.store.deletionRequest).toBeNull();
    expect(h.deps.saveRequest).not.toHaveBeenCalled();
    emit.mockImplementation(async () => undefined);
    expect((await scheduleStoreDeletion(await input(), h.deps)).state).toBe('pending');
  });

  it('M5 (Ruling DEL-FLAG-1): with the erasure flag off a Durable Object store is refused at preview, schedule and execution, never deleted', async () => {
    const blocked = vi.fn(async () => true);
    const p = await previewStoreDeletion(
      { storeId: 'store-a', userId: OWNER },
      makeDeps({ erasureBlocked: blocked }).deps
    );
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons[0].code).toBe('ERASURE_NOT_ENABLED');
    // flag on at schedule time, off again at execution (an operator turned it off): the delete does not run
    const flag = vi.fn(async () => false);
    const h = await scheduledStore({ erasureBlocked: flag });
    flag.mockResolvedValue(true);
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('blocked');
    expect(h.deps.deleteStore).not.toHaveBeenCalled();
    expect(h.state.store.deletionRequest?.lastBlock?.code).toBe('ERASURE_NOT_ENABLED');
    flag.mockResolvedValue(false);
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps)).outcome
    ).toBe('executed');
  });
});

describe('follow-up of #772: automatic retry after a failed run, and a committed delete whose post-commit step threw', () => {
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
  const failExecuting = async (h: Awaited<ReturnType<typeof scheduledStore>>) => {
    await expect(
      executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps)
    ).rejects.toThrow();
  };

  it('m1: a recovery re-sends the execute event for now + 1 day, so the retry really happens', async () => {
    const h = await scheduledStore({
      deleteStore: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await failExecuting(h);
    (h.deps.emit as ReturnType<typeof vi.fn>).mockClear();
    const { recoverFailedExecution } = await import('@api/services/store-deletion.service');
    const r = await recoverFailedExecution(
      { storeId: 'store-a', requestId: h.r.id, reason: 'boom' },
      h.deps
    );
    expect(r).toMatchObject({
      recovered: true,
      retryScheduled: true,
      exhausted: false,
      attempt: 1,
    });
    expect(h.deps.emit).toHaveBeenCalledWith('store/deletion.scheduled', {
      storeId: 'store-a',
      requestId: h.r.id,
      executeAfter: new Date(h.deps.now() + 86_400_000).toISOString(),
    });
    expect(h.state.store.deletionRequest?.recoveries).toBe(1);
  });

  it('m1: after 5 recoveries the next failure queues nothing and reports exhausted (manual action)', async () => {
    const h = await scheduledStore({
      deleteStore: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { recoverFailedExecution } = await import('@api/services/store-deletion.service');
    const results = [];
    for (let i = 0; i < 6; i++) {
      await failExecuting(h);
      results.push(
        await recoverFailedExecution(
          { storeId: 'store-a', requestId: h.r.id, reason: 'boom' },
          h.deps
        )
      );
    }
    expect(results.slice(0, 5).every(x => x.retryScheduled)).toBe(true);
    expect(results[5]).toMatchObject({ recovered: true, retryScheduled: false, exhausted: true });
    // 1 (schedule) + 5 retries, never a 6th
    expect(h.deps.emit).toHaveBeenCalledTimes(6);
  });

  it('m1: a failed re-queue is reported (retryScheduled false), not hidden', async () => {
    const emit = vi.fn(async () => undefined);
    const h = await scheduledStore({
      emit,
      deleteStore: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await failExecuting(h);
    emit.mockRejectedValue(new Error('inngest down'));
    const { recoverFailedExecution } = await import('@api/services/store-deletion.service');
    expect(
      await recoverFailedExecution({ storeId: 'store-a', requestId: h.r.id, reason: 'x' }, h.deps)
    ).toMatchObject({ recovered: true, retryScheduled: false, exhausted: false });
  });

  it('m2: the delete committed and a post-commit step threw: the retry (store gone) still audits, emails, finishes the steps and clears the marker', async () => {
    let hh: Awaited<ReturnType<typeof scheduledStore>>;
    const del = vi.fn(async () => {
      hh.markDeleted(); // the Postgres delete committed...
      throw new Error('post-commit step failed'); // ...then a step threw
    });
    hh = await scheduledStore({ deleteStore: del });
    await failExecuting(hh);
    expect(hh.deps.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETED_BY_OWNER' })
    );
    expect(hh.markers.size).toBe(1);
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: hh.r.id }, hh.deps);
    expect(o.outcome).toBe('executed');
    expect(hh.deps.finishDeletedStore).toHaveBeenCalledWith({
      id: 'store-a',
      slug: 'shop-a',
      ownerId: OWNER,
      onDo: false,
    });
    expect(hh.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETED_BY_OWNER' })
    );
    expect(hh.deps.notifyOwner).toHaveBeenCalledWith(
      'executed',
      expect.objectContaining({ to: 'owner@example.com' })
    );
    expect(hh.markers.size).toBe(0);
    // and a third run is the plain 'gone'
    expect(
      (await executeStoreDeletion({ storeId: 'store-a', requestId: hh.r.id }, hh.deps)).outcome
    ).toBe('gone');
  });

  it('m2: a store that is gone WITHOUT a claim marker for this request stays a plain gone (no audit, no email)', async () => {
    const h = await scheduledStore();
    h.markDeleted(); // e.g. a super admin deleted it during the window
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('gone');
    expect(h.deps.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETED_BY_OWNER' })
    );
    expect(h.deps.finishDeletedStore).not.toHaveBeenCalled();
  });

  it('m2: a marker that belongs to a DIFFERENT request never completes this one', async () => {
    const h = await scheduledStore();
    h.markers.set('store-a', {
      requestId: 'some-other-request',
      requestedBy: OWNER,
      slug: 'shop-a',
      storeName: 'Shop A',
      ownerId: OWNER,
      onDo: false,
    });
    h.markDeleted();
    const o = await executeStoreDeletion({ storeId: 'store-a', requestId: h.r.id }, h.deps);
    expect(o.outcome).toBe('gone');
    expect(h.deps.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DELETED_BY_OWNER' })
    );
  });

  it('m2: a recovery for a committed delete (store gone) still queues the retry that finishes it', async () => {
    let hh: Awaited<ReturnType<typeof scheduledStore>>;
    hh = await scheduledStore({
      deleteStore: vi.fn(async () => {
        hh.markDeleted();
        throw new Error('post-commit step failed');
      }),
    });
    await failExecuting(hh);
    (hh.deps.emit as ReturnType<typeof vi.fn>).mockClear();
    const { recoverFailedExecution } = await import('@api/services/store-deletion.service');
    expect(
      await recoverFailedExecution({ storeId: 'store-a', requestId: hh.r.id, reason: 'x' }, hh.deps)
    ).toMatchObject({ recovered: true, retryScheduled: true });
    expect(hh.deps.emit).toHaveBeenCalledTimes(1);
  });
});
