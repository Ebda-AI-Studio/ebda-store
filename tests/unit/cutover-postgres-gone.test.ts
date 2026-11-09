/**
 * P1 2026-11-09: production's `ebda-platform` had no `platform_cutover.ai-usage` row, so on the Postgres-less Worker every AI quota
 * check went to Postgres and threw POSTGRES_REMOVED. With Postgres gone an unflipped family is served by D1 (read, write and the
 * audit sink) with ONE P1 per family per isolate; with Postgres present (Node, tests, dev) the marker semantics are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  postgresGone: true,
  rows: [] as Array<{ key: string; value: string }>,
  alerts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@api/lib/postgres-present', () => ({
  postgresRemovedOnThisWorker: () => h.postgresGone,
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: async (a: Record<string, unknown>) => {
    h.alerts.push(a);
    return { sent: true };
  },
}));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: h.rows }) }),
      }),
    },
  }),
}));

import {
  auditStoreLessOnD1,
  platformFamilyOnD1,
  platformFamilyOnD1ForWrite,
  resetCutoverCache,
} from '@api/services/platform/cutover';

beforeEach(() => {
  resetCutoverCache();
  h.postgresGone = true;
  h.rows = [];
  h.alerts = [];
});

describe('a family with no cutover marker', () => {
  it('is served by D1 on a Worker without Postgres (read, write, audit) and pages P1 once per family', async () => {
    expect(await platformFamilyOnD1('ai-usage')).toBe(true);
    expect(await platformFamilyOnD1('ai-usage')).toBe(true);
    expect(await platformFamilyOnD1ForWrite('ai-usage')).toBe(true);
    expect(await auditStoreLessOnD1()).toBe(true);
    await Promise.resolve();
    expect(h.alerts.map(a => (a.context as { family: string }).family)).toEqual([
      'ai-usage',
      'audit',
    ]);
    expect(h.alerts[0]).toMatchObject({ level: 'p1', source: 'platform.cutover' });
  });

  it('stays on Postgres where Postgres is present (marker semantics unchanged, no page)', async () => {
    h.postgresGone = false;
    expect(await platformFamilyOnD1('ai-usage')).toBe(false);
    expect(await platformFamilyOnD1ForWrite('ai-usage')).toBe(false);
    expect(await auditStoreLessOnD1()).toBe(false);
    expect(h.alerts).toEqual([]);
  });

  it('a frozen family still refuses a write (the freeze wins over the no-Postgres default)', async () => {
    h.rows = [{ key: 'platform_freeze.ai-usage', value: '{}' }];
    await expect(platformFamilyOnD1ForWrite('ai-usage')).rejects.toMatchObject({
      code: 'PLATFORM_FAMILY_FROZEN',
    });
  });

  it('a flipped family is on D1 with no page', async () => {
    h.rows = [{ key: 'platform_cutover.ai-usage', value: '{"on":true}' }];
    expect(await platformFamilyOnD1('ai-usage')).toBe(true);
    expect(h.alerts).toEqual([]);
  });
});
