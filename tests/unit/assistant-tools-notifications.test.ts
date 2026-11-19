/** Notification assistant tool (plan 4 C2): per-event SMS / phone-push switches. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';
import { applyThenUndo } from './helpers/undo-roundtrip';

const m = vi.hoisted(() => ({
  events: {} as Record<string, unknown>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  upsertEventConfig: vi.fn(),
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
vi.mock('@api/services/notification-config.service', () => ({
  notificationConfigService: {
    getEventConfigs: async () => m.events,
    upsertEventConfig: m.upsertEventConfig,
  },
}));

import { notificationsTools } from '@api/smart-layer/tools/notifications.tools';

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
const t: ToolSpec = notificationsTools()[0]!;
const args = { events: [{ event: 'order_confirmed', push: false, sms: true }] };

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.events = { order_confirmed: { whatsapp: false, sms: false, push: true } };
});

describe('notification_settings', () => {
  it('is a reversible preview tool with no store id or credential', () => {
    expect(t.name).toBe('notification_settings');
    expect(t.policy).toBe('confirm');
    expect(t.messagesCustomers).toBe(true);
    expect(t.undo).toBe('reversible');
    expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id|password|apiKey|secret|token/i);
    expect(
      t.args.safeParse({ events: [{ event: 'order_confirmed', apiKey: 'x', sms: true }] }).success
    ).toBe(false);
    expect(t.args.safeParse({ events: [{ event: 'order_confirmed' }] }).success).toBe(false);
    expect(t.args.safeParse({ events: [{ event: 'nope', sms: true }] }).success).toBe(false);
  });
  it('preview lists before/after, an etag and the restore values', async () => {
    const d = await t.preview!(ctx(), t.args.parse(args));
    expect(d.rows.map(r => [r.before, r.after])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(d.affectedCount).toBe(1);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect((d.payload as { restore: unknown }).restore).toEqual({
      events: [{ event: 'order_confirmed', sms: false, push: true }],
    });
  });
  it('apply goes through runAsMerchant as the assistant and carries whatsapp through', async () => {
    m.events = { order_confirmed: { whatsapp: true, sms: false, push: true } };
    const a = t.args.parse(args);
    const r = await t.apply!(ctx(), a, await t.preview!(ctx(), a));
    expect(r.ok).toBe(true);
    expect(m.upsertEventConfig).toHaveBeenCalledWith('S1', 'order_confirmed', {
      whatsapp: true,
      sms: true,
      push: false,
    });
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
      actor: 'assistant',
      phase: 'intent',
      tool: 'notification_settings',
    });
  });
  it('staff is forbidden, a hand edit changes the etag, the inverse restores', async () => {
    const a = t.args.parse(args);
    const d = await t.preview!(ctx(), a);
    await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.upsertEventConfig).not.toHaveBeenCalled();
    m.events = { order_confirmed: { whatsapp: false, sms: true, push: true } };
    expect((await t.preview!(ctx(), a)).etag).not.toBe(d.etag);
    const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
    expect(inv).toEqual({
      tool: 'notification_settings',
      args: { events: [{ event: 'order_confirmed', sms: false, push: true }] },
    });
    expect(() => t.args.parse(inv!.args)).not.toThrow();
  });
  it('an event with no row shows the dispatcher default (sms on, push on)', async () => {
    m.events = {};
    const d = await t.preview!(ctx(), t.args.parse(args));
    expect(d.rows.map(r => r.before)).toEqual([true, true]);
  });
  it('is a confirm card that says SMS goes to customers and is charged to the merchant, per event', async () => {
    const a = t.args.parse({
      events: [
        { event: 'order_shipped', sms: true },
        { event: 'back_in_stock', sms: true, push: true },
      ],
    });
    const d = await t.preview!(ctx(), a);
    expect(effectivePolicy(t, d).reasons).toContain('customer_message');
    expect(effectivePolicy(t, d).policy).toBe('confirm');
    const smsRows = d.rows.filter(r => /SMS/.test(r.label.en));
    expect(smsRows).toHaveLength(2);
    for (const r of smsRows) {
      expect(r.label.en).toMatch(/your customer's phone, each message is charged to you/);
      expect(r.label.ar).toMatch(/للعميل.*بتتحاسب عليك/);
    }
    expect(smsRows[1]!.label.en).toMatch(/consent/);
    expect(smsRows[0]!.label.en).not.toMatch(/consent/);
    expect(d.summary.en).toMatch(/SMS goes to your customers and each message is charged to you/);
    expect(t.description).toMatch(/CUSTOMERS/);
    expect(t.description).not.toMatch(/notify the merchant/);
  });
  it('only the dispatcher events are accepted', () => {
    for (const ev of [
      'order_confirmed',
      'payment_success',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
      'refund_processed',
      'cart_abandoned_step1',
      'cart_abandoned_step2',
      'cart_abandoned_step3',
      'back_in_stock',
    ])
      expect(t.args.safeParse({ events: [{ event: ev, sms: true }] }).success).toBe(true);
    for (const ev of ['payment_failed', 'order_refunded'])
      expect(t.args.safeParse({ events: [{ event: ev, sms: true }] }).success).toBe(false);
  });
  it('staff is refused at preview (no card) and at apply; mutation: the role gate', async () => {
    const a = t.args.parse(args);
    await expect(t.preview!(ctx('staff'), a)).rejects.toThrow(/FORBIDDEN/);
    const d = await t.preview!(ctx(), a);
    await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
  });
  it('undo through the engine restores the previous switches', async () => {
    const r = await applyThenUndo([t], t, args);
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('undone');
  });
});
