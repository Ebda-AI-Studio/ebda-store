/** Account assistant tools (plan 4 C2): profile_update (own name / phone only). */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ToolForbidden, type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  profile: {} as Record<string, unknown>,
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { getProfile: m.getProfile, updateProfile: m.updateProfile },
}));

import { MerchantForbidden } from '@api/mcp/run-as-merchant';
import { applyThenUndo } from './helpers/undo-roundtrip';
import { accountTools } from '@api/smart-layer/tools/account.tools';

const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const t = (): ToolSpec => accountTools().find(x => x.name === 'profile_update')!;
const parse = (a: unknown) => t().args.parse(a) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.insertAuditLog.mockResolvedValue(undefined);
  m.profile = {
    firstName: 'Ahmad',
    lastName: 'S',
    phone: '0100',
    email: 'a@b.c',
    updatedAt: '2026-11-01',
  };
  m.getProfile.mockImplementation(async () => m.profile);
  m.updateProfile.mockResolvedValue({});
});

describe('profile_update', () => {
  it('is preview, reversible and never takes a store id, e-mail, password, MFA or role', () => {
    expect(t().policy).toBe('preview');
    expect(t().undo).toBe('reversible');
    expect(JSON.stringify(t().jsonSchema)).not.toMatch(/store_?id|email|password|mfa|role/i);
    for (const bad of ['email', 'password', 'currentPassword', 'mfaEnabled', 'role', 'storeId'])
      expect(t().args.safeParse({ firstName: 'x', [bad]: 'y' }).success).toBe(false);
    expect(t().args.safeParse({}).success).toBe(false);
  });

  it('preview shows before/after rows, an etag and the BEFORE values of only the sent fields', async () => {
    const d = await t().preview!(ctx(), parse({ firstName: 'Ahmed', phone: '0111' }));
    expect(d.rows.map(r => [r.before, r.after])).toEqual([
      ['Ahmad', 'Ahmed'],
      ['0100', '0111'],
    ]);
    expect(d.affectedCount).toBe(1);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect((d.payload as { restore: unknown }).restore).toEqual({
      firstName: 'Ahmad',
      phone: '0100',
    });
    m.profile = { ...m.profile, updatedAt: '2026-11-02' };
    expect((await t().preview!(ctx(), parse({ firstName: 'Ahmed', phone: '0111' }))).etag).not.toBe(
      d.etag
    );
  });

  it('apply goes through runAsMerchant as the assistant and calls updateProfile for the signed-in user', async () => {
    const args = parse({ lastName: 'Sharaf' });
    const r = await t().apply!(ctx(), args, await t().preview!(ctx(), args));
    expect(r.ok).toBe(true);
    expect(m.updateProfile).toHaveBeenCalledWith('u1', { lastName: 'Sharaf' }, { storeId: null });
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
      actor: 'assistant',
      tool: 'profile_update',
    });
  });

  it('a platform super admin never reaches it', async () => {
    const args = parse({ lastName: 'x' });
    await expect(t().preview!(ctx('super_admin'), args)).rejects.toBeInstanceOf(Error);
    await expect(t().apply!(ctx('super_admin'), args, {} as never)).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.updateProfile).not.toHaveBeenCalled();
  });

  it('the inverse restores the before values through the same tool (and skips what cannot be restored)', async () => {
    const args = parse({ firstName: 'Ahmed', phone: '0111' });
    const d = await t().preview!(ctx(), args);
    const inv = t().inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' });
    expect(inv).toEqual({ tool: 'profile_update', args: { firstName: 'Ahmad', phone: '0100' } });
    expect(() => t().args.parse(inv!.args)).not.toThrow();
    m.profile = { ...m.profile, phone: null };
    const d2 = await t().preview!(ctx(), parse({ phone: '0111' }));
    expect(
      t().inverse!(ctx(), parse({ phone: '0111' }), d2, { ok: true, etagAfter: 'x' })
    ).toBeNull();
  });

  it('engine round trip: undo of a profile change is `undone` and restores the before values', async () => {
    const r = await applyThenUndo(
      accountTools(),
      t(),
      parse({ firstName: 'Ahmed', phone: '0111' })
    );
    expect(r).toMatchObject({ applied: 'applied', undo: 'undone' });
    expect(m.updateProfile).toHaveBeenCalledTimes(2);
    expect(m.updateProfile.mock.calls[1][1]).toEqual({ firstName: 'Ahmad', phone: '0100' });
  });

  it('a platform super admin gets no card at preview (the only role this route refuses)', async () => {
    await expect(t().preview!(ctx('super_admin'), parse({ lastName: 'x' }))).rejects.toBeInstanceOf(
      MerchantForbidden
    );
  });
});
