import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestBudget, sampleWeight, storeShard } from '../../lib/request-budget';
import { breaches, runRequestBudgetAlert } from '../../lib/request-budget-alert';

function appWith(points: Array<Record<string, unknown>>, rand = () => 0) {
  const app = express();
  app.use(requestBudget(() => ({ writeDataPoint: p => void points.push(p) }), rand));
  const r = express.Router();
  r.get('/stores/:storeId/products/:id', (_q, s) => void s.json({ ok: true }));
  r.get('/boom', (_q, s) => void s.status(500).json({}));
  app.use('/api/v1', r);
  return app;
}
const settle = () => new Promise(r => setTimeout(r, 10));

describe('requestBudget (FOLD-COUNTERS)', () => {
  it('counts a new route by its TEMPLATE, never the raw path or the store id', async () => {
    const points: Array<Record<string, unknown>> = [];
    await request(appWith(points)).get(
      '/api/v1/stores/store-secret-123/products/p-9?email=a@b.com'
    );
    await settle();
    expect(points).toHaveLength(1);
    const json = JSON.stringify(points[0]);
    expect(points[0]!.indexes).toEqual(['/api/v1/stores/:storeId/products/:id']);
    expect(json).not.toContain('store-secret-123');
    expect(json).not.toContain('a@b.com');
    expect((points[0]!.blobs as string[])[0]).toBe(storeShard('store-secret-123'));
    expect(points[0]!.blobs).toEqual([storeShard('store-secret-123'), 'GET', '2xx']);
  });
  it('samples 1 in 20 for healthy fast requests but always keeps non-2xx', async () => {
    const points: Array<Record<string, unknown>> = [];
    const app = appWith(points, () => 0.9);
    await request(app).get('/api/v1/stores/s/products/p');
    await request(app).get('/api/v1/boom');
    await request(app).get('/api/v1/nope');
    await settle();
    expect(points.map(p => (p.blobs as string[])[2])).toEqual(['5xx', '4xx']);
    expect(points.map(p => (p.doubles as number[])[0])).toEqual([1, 1]);
    expect(points[1]!.indexes).toEqual(['unmatched']);
  });
  it('sample weights stand for the requests they represent', () => {
    expect(sampleWeight(200, 10, () => 0)).toBe(20);
    expect(sampleWeight(200, 10, () => 0.5)).toBe(0);
    expect(sampleWeight(503, 10, () => 0.5)).toBe(1);
    expect(sampleWeight(200, 5000, () => 0.5)).toBe(1);
  });
  it('writes nothing and never errors when REQUEST_BUDGET is unbound', async () => {
    const app = express();
    app.use(requestBudget(() => undefined));
    app.get('/x', (_q, s) => void s.send('ok'));
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
  });
  it('a throwing sink never affects the response', async () => {
    const app = express();
    app.use(
      requestBudget(
        () => ({
          writeDataPoint: () => {
            throw new Error('ae down');
          },
        }),
        () => 0
      )
    );
    app.get('/x', (_q, s) => void s.send('ok'));
    expect((await request(app).get('/x')).status).toBe(200);
  });
  it('guard: app.ts mounts it before every router, and wrangler binds the dataset', () => {
    const src = readFileSync(join(__dirname, '../../app.ts'), 'utf8');
    const mw = src.indexOf('app.use(requestBudget())');
    expect(mw).toBeGreaterThan(0);
    expect(mw).toBeLessThan(src.indexOf("app.use('/api/v1', routes)"));
    expect(mw).toBeLessThan(src.indexOf("app.use('/api/v1/webhooks'"));
    const wr = readFileSync(join(__dirname, '../../../wrangler.jsonc'), 'utf8');
    expect(wr).toMatch(/"binding": "REQUEST_BUDGET", "dataset": "ebda_request_budget"/);
  });
});

describe('request budget alert', () => {
  it('flags p95 and 5xx-rate breaches, ignores quiet routes', () => {
    expect(
      breaches([
        { route: '/a', requests: 500, p95Ms: 2000, errors5xx: 0 },
        { route: '/b', requests: 500, p95Ms: 100, errors5xx: 50 },
        { route: '/c', requests: 10, p95Ms: 9000, errors5xx: 10 },
        { route: '/d', requests: 500, p95Ms: 100, errors5xx: 1 },
      ]).map(b => b.route)
    ).toEqual(['/a', '/b']);
  });
  it('is skipped without secrets, otherwise one alert per breaching route', async () => {
    expect(await runRequestBudgetAlert({}, vi.fn() as never, vi.fn() as never)).toEqual({
      skipped: true,
      alerted: 0,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ route: '/slow', requests: 400, p95_ms: 3000, errors_5xx: 0 }],
      }),
    })) as never;
    const send = vi.fn(async () => 'sent') as never;
    expect(await runRequestBudgetAlert({ accountId: 'a', token: 't' }, fetchImpl, send)).toEqual({
      skipped: false,
      alerted: 1,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'cron.request-budget' })
    );
  });
});
