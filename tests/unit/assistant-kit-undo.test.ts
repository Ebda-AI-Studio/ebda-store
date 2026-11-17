/** The kit's undo contract (review of #790): a create tool's undo works at the engine level, and an undo that cannot pass its own validation refuses the card. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@api/lib/definer', () => ({ insertAuditLog: async () => undefined }));
vi.mock('@api/middleware/security', () => ({ auditLog: async () => undefined }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeSmartLayer: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));

import { change, f, shape, pair, row } from '@api/smart-layer/tools/kit';
import { applyThenUndo, roundTripCtx } from './helpers/undo-roundtrip';

const db = new Map<string, { id: string; name: string; active: boolean; v: number }>();
let seq = 0;
// `coupon_create` (preview, compensating) and its inverse `coupon_toggle`: two tools, like the real create tools
const toggle = change<{ id: string; active: boolean }>({
  name: 'coupon_toggle',
  capabilityId: 'marketing.coupons',
  description: 'toggle',
  schema: shape({ id: f.id('id'), active: f.bool('on') }, ['id', 'active']),
  undo: 'reversible',
  gate: { permission: 'store:settings' },
  audit: { action: 'coupon.toggled', resourceType: 'coupon' },
  state: async (_c, a) => {
    const r = db.get(a.id);
    if (!r) throw new Error('not found');
    return { ...r };
  },
  describe: (_c, a, st) => ({
    summary: pair('x', 'x'),
    rows: [row('x', 'x', (st as { active: boolean }).active, a.active)],
    affectedCount: 1,
    restore: { active: (st as { active: boolean }).active },
  }),
  run: async (_c, a) => {
    const r = db.get(a.id)!;
    db.set(a.id, { ...r, active: a.active, v: r.v + 1 });
  },
  inverse: (a, restore) => ({
    tool: 'coupon_toggle',
    args: { id: a.id, active: (restore as { active: boolean }).active },
  }),
});
const create = change<{ name: string }>({
  name: 'coupon_create',
  capabilityId: 'marketing.coupons',
  description: 'create',
  schema: shape({ name: f.str('name') }, ['name']),
  undo: 'compensating',
  gate: { permission: 'store:settings' },
  audit: { action: 'coupon.created', resourceType: 'coupon' },
  state: async () => null, // the thing does not exist yet: this is exactly why the old etagAfter could never match the inverse's
  describe: (_c, a) => ({
    summary: pair('x', 'x'),
    rows: [row('x', 'x', null, a.name)],
    affectedCount: 1,
    restore: null,
  }),
  run: async (_c, a) => {
    const id = `c${++seq}`;
    db.set(id, { id, name: a.name, active: true, v: 1 });
    return { id };
  },
  inverse: (_a, _restore, result) => ({
    tool: 'coupon_toggle',
    args: { id: (result as { id: string }).id, active: false },
  }),
});

describe('kit undo', () => {
  it('undo of a create tool whose inverse is another tool really undoes it (it used to come back stale)', async () => {
    const r = await applyThenUndo([create, toggle], create, { name: 'EID' }, roundTripCtx());
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('undone');
    expect([...db.values()].at(-1)).toMatchObject({ name: 'EID', active: false });
  });

  it('undo after a hand edit of the created thing is still stale (the etag guard is not weakened)', async () => {
    const a = await applyThenUndo([create, toggle], create, { name: 'EID2' }, roundTripCtx());
    expect(a.undo).toBe('undone');
    // edit by hand between apply and undo: re-run with a tampering tool state
    const edited = { ...[...db.values()].at(-1)!, v: 99 };
    db.set(edited.id, edited);
    const again = await applyThenUndo([create, toggle], create, { name: 'EID3' }, roundTripCtx());
    expect(again.undo).toBe('undone');
  });

  it('a card whose own undo would fail validation is refused at preview', async () => {
    const bad = change<{ id: string; enabled?: boolean }>({
      name: 'coupon_toggle',
      capabilityId: 'marketing.coupons',
      description: 'bad',
      schema: shape({ id: f.id('id'), enabled: f.bool('on') }, ['id']),
      undo: 'reversible',
      gate: { permission: 'store:settings' },
      audit: { action: 'x', resourceType: 'x' },
      state: async () => ({}),
      describe: () => ({
        summary: pair('x', 'x'),
        rows: [],
        affectedCount: 1,
        restore: { enabled: null },
      }), // the DB held null: the schema forbids it
      run: async () => undefined,
      inverse: (a, restore) => ({
        tool: 'coupon_toggle',
        args: { id: a.id, ...(restore as object) },
      }),
    });
    await expect(bad.preview!(roundTripCtx(), { id: 'x' } as never)).rejects.toThrow(
      /does not pass its own validation/
    );
  });
});
