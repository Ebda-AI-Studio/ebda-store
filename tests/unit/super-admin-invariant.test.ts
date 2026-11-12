/** Ruling ID-20: the daily platform-admin invariant raises a P1 on 0 active, 0 ready, or when it cannot measure. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accounts: undefined as
    | undefined
    | { superAdminSummary?: () => Promise<{ active: number; ready: number }> },
  alerts: [] as Array<Record<string, unknown>>,
}));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => ({ ACCOUNTS: h.accounts }) }));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: async (a: Record<string, unknown>) => void h.alerts.push(a),
}));

import { checkSuperAdminInvariant } from '@api/lib/super-admin-invariant';
import { CRON_SCHEDULE } from '@api/cf/cron';

const summary = (active: number, ready: number) => ({
  superAdminSummary: async () => ({ active, ready }),
});

beforeEach(() => {
  h.alerts = [];
  h.accounts = undefined;
});

describe('super-admin invariant', () => {
  it('0 active super_admins -> one P1 naming the bootstrap script', async () => {
    h.accounts = summary(0, 0);
    expect(await checkSuperAdminInvariant()).toBe('none-active');
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ level: 'p1', title: 'No active platform administrator' });
    expect(String(h.alerts[0].body)).toMatch(/bootstrap-super-admin\.mjs/);
  });

  it('active but none with a second factor -> P1', async () => {
    h.accounts = summary(1, 0);
    expect(await checkSuperAdminInvariant()).toBe('none-ready');
    expect(h.alerts[0]).toMatchObject({
      level: 'p1',
      title: 'No platform administrator can act yet',
    });
  });

  it('at least one ready admin -> silent', async () => {
    h.accounts = summary(2, 1);
    expect(await checkSuperAdminInvariant()).toBe('ok');
    expect(h.alerts).toHaveLength(0);
  });

  it('missing binding or a failing RPC is a P1, never a silent pass', async () => {
    expect(await checkSuperAdminInvariant()).toBe('unmeasured');
    h.accounts = {
      superAdminSummary: async () => {
        throw new Error('boom');
      },
    };
    expect(await checkSuperAdminInvariant()).toBe('unmeasured');
    expect(h.alerts.map(a => a.level)).toEqual(['p1', 'p1']);
  });

  it('is scheduled daily', () => {
    expect(CRON_SCHEDULE['0 3 * * *'].map(j => j.name)).toContain('super-admin-invariant');
  });
});
