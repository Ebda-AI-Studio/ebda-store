/** Ruling PERF-AUTHSTATE-1 (measurement): the placement echo is flag-gated, super_admin + MFA, mounted before the admin catch-all, and reports per-instance colo + RTT. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const asked: string[] = [];
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () => ({
    AUTH_STATE: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        colo: async () => {
          asked.push(id);
          if (id === 'shard-3') throw new Error('down');
          return id.startsWith('cachegen') ? 'CDG' : 'FRA';
        },
      }),
    },
  }),
  cfWaitUntil: () => undefined,
}));

import { CACHEGEN_SHARD, authStateColos } from '../../apps/api/src/cf/auth-state-client';

const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

describe('authStateColos', () => {
  it('names each instance, reports its colo and an rtt, and a failing one as null', async () => {
    const r = await authStateColos([0, 3, CACHEGEN_SHARD, CACHEGEN_SHARD - 1]);
    expect(r.map(x => x.name)).toEqual(['shard-0', 'shard-3', 'cachegen', 'cachegen-s0']);
    expect(r.map(x => x.colo)).toEqual(['FRA', null, 'CDG', 'CDG']);
    for (const x of r) expect(Number.isInteger(x.rttMs)).toBe(true);
    expect(asked).toContain('cachegen-s0');
  });
});

describe('route wiring', () => {
  const route = read('apps/api/src/routes/admin-do-colo.routes.ts');
  it('is off unless DO_COLO_ECHO=on, and needs super_admin + MFA', () => {
    expect(route).toContain("process.env.DO_COLO_ECHO !== 'on'");
    expect(route).toContain("authenticate, requireMfaEnrolled, authorize('super_admin')");
  });
  it('returns location codes and numbers only (no ids, hosts or request data)', () => {
    expect(route).not.toMatch(/req\.(headers|ip|body|query)/);
  });
  it('is mounted before the admin catch-all', () => {
    const idx = read('apps/api/src/routes/index.ts');
    expect(idx.indexOf("router.use('/admin', adminDoColoRoutes)")).toBeGreaterThan(0);
    expect(idx.indexOf("router.use('/admin', adminDoColoRoutes)")).toBeLessThan(
      idx.indexOf("router.use('/admin', tenantContext, adminRoutes")
    );
  });
});
