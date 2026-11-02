/**
 * Fail loud at boot: a DEPLOYED Worker (isWorkers) with no PLATFORM_DB reports status "degraded" + platform_db "unbound", which the
 * deploy-guard probe (status === "ok" + commit) refuses, so the deploy rolls back instead of silently serving the legacy Postgres paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ workers: true }));
vi.mock('../../apps/api/src/lib/runtime', () => ({
  get isWorkers() {
    return h.workers;
  },
}));

import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import { healthPayload } from '../../apps/api/src/lib/health-payload';

beforeEach(() => clearCfBindings());

const d1 = (ok: boolean) => ({
  prepare: () => ({ all: async () => (ok ? { results: [] } : Promise.reject(new Error('down'))) }),
});

describe('/health and the platform D1', () => {
  it('a deployed Worker without PLATFORM_DB is degraded and says unbound', async () => {
    h.workers = true;
    const body = await healthPayload({});
    expect(body.status).toBe('degraded');
    expect(body.platform_db).toBe('unbound');
  });
  it('a deployed Worker with PLATFORM_DB is ok', async () => {
    h.workers = true;
    setCfBindings({ PLATFORM_DB: d1(true) } as never);
    const body = await healthPayload({});
    expect(body.status).toBe('ok');
    expect(body.platform_db).toBe('ok');
  });
  it('Node / local / tests (not a Worker) keep status ok with the field omitted', async () => {
    h.workers = false;
    const body = await healthPayload({});
    expect(body.status).toBe('ok');
    expect('platform_db' in body).toBe(false);
  });
  it('the deploy-guard probe refuses a degraded body', async () => {
    const src = (await import('node:fs')).readFileSync('scripts/ci/deploy-guard.mjs', 'utf8');
    expect(src).toMatch(/body\?\.status !== 'ok'/);
  });
});
