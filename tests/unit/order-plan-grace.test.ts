import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  entitlements: vi.fn(),
  count: vi.fn(),
  sub: vi.fn(),
  store: vi.fn(),
}));
vi.mock('@force/database', () => ({
  prisma: {},
  withStore: (_id: string, fn: Function) =>
    fn({
      order: { count: m.count },
      storeSubscription: { findUnique: m.sub },
      store: { findUnique: m.store },
    }),
}));
vi.mock('../../apps/api/src/services/plan-entitlements', () => ({
  getEntitlements: m.entitlements,
  parseLimits: vi.fn(),
}));
vi.mock('../../apps/api/src/services/socket.service', () => ({ socketService: {} }));
vi.mock('../../apps/api/src/services/email.service', () => ({ EmailService: {} }));
vi.mock('../../apps/api/src/config', () => ({ config: {} }));
vi.mock('../../apps/api/src/lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
import { assertOrderAllowed } from '../../apps/api/src/services/plan-limit.service';

describe('order grace', () => {
  beforeEach(() => {
    m.store.mockResolvedValue({ isDemo: false });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    m.entitlements.mockResolvedValue({
      planCode: 'basic',
      status: 'active',
      limits: { maxOrdersPerMonth: 300 },
    });
    m.count.mockResolvedValue(301);
    m.sub.mockResolvedValue({
      ordersOverLimitMonth: new Date('2026-10-01T00:00:00Z'),
      ordersOverLimitNotifiedAt: new Date('2026-10-13T12:00:00Z'),
    });
  });
  afterEach(() => vi.useRealTimers());
  it('blocks at exactly seven days', async () => {
    await expect(assertOrderAllowed('s')).rejects.toMatchObject({ statusCode: 402 });
  });
  it('accepts during grace', async () => {
    vi.setSystemTime(new Date('2026-10-20T11:59:59Z'));
    await expect(assertOrderAllowed('s')).resolves.toBeUndefined();
  });
  it('allows a recovered usage count', async () => {
    m.count.mockResolvedValue(300);
    await expect(assertOrderAllowed('s')).resolves.toBeUndefined();
  });
  it('blocks an expired trial', async () => {
    m.entitlements.mockResolvedValue({
      planCode: 'growth',
      status: 'trialing',
      trialEndsAt: new Date('2026-10-20T12:00:00Z'),
      limits: { maxOrdersPerMonth: 3000 },
    });
    await expect(assertOrderAllowed('s')).rejects.toMatchObject({ statusCode: 402 });
  });
});

describe('demo store gate', () => {
  it('refuses a demo store before reading entitlements', async () => {
    m.store.mockResolvedValue({ isDemo: true });
    m.entitlements.mockClear();
    await expect(assertOrderAllowed('s')).rejects.toMatchObject({
      statusCode: 403,
      code: 'DEMO_STORE',
    });
    expect(m.entitlements).not.toHaveBeenCalled();
  });
});
