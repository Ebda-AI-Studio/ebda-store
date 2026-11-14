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
  COOLING_OFF_MS,
  previewStoreDeletion,
  scheduleStoreDeletion,
  cancelStoreDeletion,
  executeStoreDeletion,
  readDeletionStatus,
  type DeletionDeps,
  type DeletionRequest,
  type DeletionStore,
} from '@api/services/store-deletion.service';

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
    moneyInFlight: vi.fn(async () => null as Record<string, number> | null),
    hasBilledSubscription: vi.fn(async () => false),
    isBillingParentWithSiblings: vi.fn(async () => false),
    deleteStore: vi.fn(async () => {
      deleted = true;
    }),
    audit: vi.fn(async () => undefined),
    emit: vi.fn(async () => undefined),
    notifyOwner: vi.fn(async () => undefined),
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
  it('a delete that throws leaves the request pending (retry converges)', async () => {
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
    expect(h.state.store.deletionRequest?.state).toBe('pending');
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
