/** Assistant tools of the self-service trust channel: contact support, suspension appeal, store limit request. They only FILE a request; staff decide. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ToolForbidden, type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  insertAuditLog: vi.fn(),
  createSupport: vi.fn(),
  fileAppeal: vi.fn(),
  fileCap: vi.fn(),
  getSuspension: vi.fn(),
  notifyStaff: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withUser: async (_u: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@api/services/trust-requests.service', () => ({
  createSupportRequest: m.createSupport,
  fileAppeal: m.fileAppeal,
  fileStoreCapRequest: m.fileCap,
  getSuspension: m.getSuspension,
  notifyStaff: m.notifyStaff,
}));

import { trustTools } from '@api/smart-layer/tools/trust.tools';

const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role,
  locale: 'en',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (n: string): ToolSpec => trustTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.insertAuditLog.mockResolvedValue(undefined);
  m.notifyStaff.mockResolvedValue({ emailQueued: true });
  m.getSuspension.mockResolvedValue({ kind: 'policy', reason: 'spam', appeal: null });
});

describe('trust tools', () => {
  it('are confirm cards, irreversible, with no inverse', () => {
    for (const n of ['contact_ebda_support', 'suspension_appeal', 'store_limit_request']) {
      expect(tool(n).policy).toBe('confirm');
      expect(tool(n).undo).toBe('irreversible');
      expect(tool(n).inverse).toBeUndefined();
    }
  });
  it('contact_ebda_support files for THIS store as this user and tells staff', async () => {
    const t = tool('contact_ebda_support');
    const args = parse('contact_ebda_support', { topic: 'billing', message: 'help' });
    m.createSupport.mockResolvedValue({ id: 'R1' });
    const d = await t.preview!(ctx(), args);
    await t.apply!(ctx(), args, d);
    expect(m.createSupport).toHaveBeenCalledWith(
      expect.anything(),
      'S1',
      { userId: 'u1' },
      { topic: 'billing', message: 'help' }
    );
    expect(m.notifyStaff).toHaveBeenCalled();
  });
  it('rejects an unknown topic', () => {
    expect(() => parse('contact_ebda_support', { topic: 'x', message: 'a' })).toThrow();
  });
  it('suspension_appeal shows the reason and files; the service refusal reaches the caller', async () => {
    const t = tool('suspension_appeal');
    const args = parse('suspension_appeal', { message: 'we fixed it' });
    const d = await t.preview!(ctx(), args);
    expect(d.rows[0].before).toBe('spam');
    m.fileAppeal.mockRejectedValue(new Error('BILLING_SUSPENSION'));
    await expect(t.apply!(ctx(), args, d)).rejects.toThrow('BILLING_SUSPENSION');
    expect(m.notifyStaff).not.toHaveBeenCalled();
    m.fileAppeal.mockResolvedValue({ id: 'A1' });
    await t.apply!(ctx(), args, d);
    expect(m.fileAppeal).toHaveBeenLastCalledWith(
      expect.anything(),
      'S1',
      { userId: 'u1' },
      'we fixed it'
    );
  });
  it('store_limit_request needs a real reason and files keyed on the user', async () => {
    const t = tool('store_limit_request');
    expect(() => parse('store_limit_request', { message: 'short' })).toThrow();
    const args = parse('store_limit_request', { message: 'I run three brands' });
    m.fileCap.mockResolvedValue({ id: 'C1' });
    await t.apply!(ctx(), args, await t.preview!(ctx(), args));
    expect(m.fileCap).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'u1' },
      { message: 'I run three brands' }
    );
  });
  it('staff cannot file for the owner', async () => {
    const t = tool('contact_ebda_support');
    await expect(
      t.apply!(
        ctx('staff'),
        parse('contact_ebda_support', { topic: 'other', message: 'a' }),
        {} as never
      )
    ).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.createSupport).not.toHaveBeenCalled();
  });
});
