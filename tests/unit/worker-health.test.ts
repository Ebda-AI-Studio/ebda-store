/**
 * Every Ebda Worker answers GET /health with 200 + the commit and deployment it runs (Ruling HEALTH-ALL-1).
 * The Next apps (admin, orders, web) answer it in the Worker entry, BEFORE OpenNext: a Next route handler
 * 500s on a Worker without an incremental cache (admin/orders), so the old app/health/route.ts never ran.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  healthResponse,
  isHealthRequest,
  withHealth,
} from '../../packages/shared/src/worker-health';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const req = (path: string, method = 'GET') => new Request(`https://x.ebda.app${path}`, { method });

describe('worker /health', () => {
  it('matches only GET/HEAD on exactly /health', () => {
    expect(isHealthRequest(req('/health'))).toBe(true);
    expect(isHealthRequest(req('/health', 'HEAD'))).toBe(true);
    expect(isHealthRequest(req('/health', 'POST'))).toBe(false);
    expect(isHealthRequest(req('/health/'))).toBe(false);
    expect(isHealthRequest(req('/healthz'))).toBe(false);
    expect(isHealthRequest(req('/a/health'))).toBe(false);
  });

  it('reports status, service, commit and deploymentId', async () => {
    const res = healthResponse('admin', {
      BUILD_COMMIT_SHA: 'abc123',
      CF_VERSION_METADATA: { id: 'ver-1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'admin',
      commit: 'abc123',
      deploymentId: 'ver-1',
    });
  });

  it('answers null (unknown), never a guess, when the build was not told', async () => {
    const body = await healthResponse('orders', {}).json();
    expect(body).toMatchObject({ commit: null, deploymentId: null });
    expect(await healthResponse('orders', { BUILD_COMMIT_SHA: '  ' }).json()).toMatchObject({
      commit: null,
    });
  });

  it('HEAD has no body', async () => {
    const res = healthResponse('web', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('withHealth serves /health itself and delegates everything else untouched', async () => {
    const inner = vi.fn(async () => new Response('page', { status: 200 }));
    const worker = withHealth('admin', { fetch: inner });
    const env = { BUILD_COMMIT_SHA: 'sha1' };
    const h = await worker.fetch(req('/health'), env, {});
    expect(h.status).toBe(200);
    expect(inner).not.toHaveBeenCalled();
    const p = await worker.fetch(req('/login'), env, {});
    expect(await p.text()).toBe('page');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('wiring: each Next app Worker answers /health with its commit', () => {
  it('admin + orders deploy a health entry, not the raw OpenNext worker', () => {
    const gen = read('scripts/cf-setup-local.sh');
    expect(gen).toContain('health-worker-entry.ts');
    expect(gen).toContain('"version_metadata": { "binding": "CF_VERSION_METADATA" }');
    for (const app of ['admin', 'orders'] as const) {
      const entry = read(`apps/${app}/health-worker-entry.ts`);
      expect(entry).toContain(`withHealth('${app}'`);
      expect(entry).toContain('.open-next/worker.js');
    }
  });

  it('web answers /health in its Sentry entry', () => {
    const entry = read('apps/web/sentry-worker-entry.ts');
    expect(entry).toContain('isHealthRequest(request)');
    expect(entry).toContain("healthResponse('web'");
  });

  it.each([
    ['admin', 'store.ebda.app'],
    ['orders', 'orders.ebda.app'],
    ['web', 'ebda-deploy-probe.ebda.app'],
  ])('%s deploy bakes the commit and verifies it live after deploy', (app, host) => {
    const y = read(`.github/workflows/cf-${app}-deploy.yml`);
    expect(y).toContain('BUILD_COMMIT_SHA:$GITHUB_SHA');
    expect(y).toContain(`--probe "https://${host}/health|200|commit=$GITHUB_SHA"`);
  });
});
