import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestBudget, storeShard } from '../../lib/request-budget';
import { breaches, runRequestBudgetAlert } from '../../lib/request-budget-alert';

type AlertedStore = NonNullable<Parameters<typeof runRequestBudgetAlert>[3]>;

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
  it('sample weights stand for the requests they represent', async () => {
    const weightOf = async (path: string, rand: () => number) => {
      const points: Array<Record<string, unknown>> = [];
      await request(appWith(points, rand)).get(path);
      await settle();
      return points.map(p => (p.doubles as number[])[0]);
    };
    expect(await weightOf('/api/v1/stores/s/products/p', () => 0)).toEqual([20]); // kept 1 in 20 stands for 20
    expect(await weightOf('/api/v1/stores/s/products/p', () => 0.5)).toEqual([]); // dropped
    expect(await weightOf('/api/v1/boom', () => 0.5)).toEqual([1]); // an error is always kept, weight 1
  });
  it('a slow healthy request is always kept at weight 1', async () => {
    const points: Array<Record<string, unknown>> = [];
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(5000);
    await request(appWith(points, () => 0.5)).get('/api/v1/stores/s/products/p');
    await settle();
    now.mockRestore();
    expect(points.map(p => (p.doubles as number[])[0])).toEqual([1]);
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

describe('requestBudget with the store id in the MOUNT path (as app.ts mounts routers)', () => {
  const UUID = 'aeaea239-5508-4ad7-82bd-4d89104dd24a';
  for (const mergeParams of [true, false]) {
    it(`labels the route with :storeId and buckets the store (mergeParams=${mergeParams})`, async () => {
      const points: Array<Record<string, unknown>> = [];
      const app = express();
      app.use(
        requestBudget(
          () => ({ writeDataPoint: p => void points.push(p) }),
          () => 0
        )
      );
      const r = express.Router({ mergeParams });
      r.get('/:id', (_q, s) => void s.json({ ok: true }));
      const mw = (_q: express.Request, _s: express.Response, next: express.NextFunction) => next();
      app.use('/api/v1/stores/:storeId/products', mw, r);
      await request(app).get(`/api/v1/stores/${UUID}/products/p-1?x=1`);
      await settle();
      expect(points).toHaveLength(1);
      expect(points[0]!.indexes).toEqual(['/api/v1/stores/:storeId/products/:id']);
      expect(JSON.stringify(points[0])).not.toContain(UUID);
      expect((points[0]!.blobs as string[])[0]).toBe(storeShard(UUID));
      expect((points[0]!.blobs as string[])[0]).not.toBe('none');
    });
  }
  it('a 404 inside a store mount still carries no raw id', async () => {
    const points: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(
      requestBudget(
        () => ({ writeDataPoint: p => void points.push(p) }),
        () => 0
      )
    );
    const r = express.Router({ mergeParams: true });
    r.get('/known', (_q, s) => void s.send('ok'));
    app.use('/api/v1/stores/:storeId/cart', r);
    await request(app).get(`/api/v1/stores/${UUID}/cart/missing`);
    await settle();
    expect(JSON.stringify(points)).not.toContain(UUID);
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

  it('pages once per incident: a sustained breach is silent until the route recovers', async () => {
    let saved: string[] = [];
    const state: AlertedStore = { get: async () => saved, put: async r => void (saved = r) };
    const send = vi.fn(async () => 'sent') as never;
    const run = (rows: Array<Record<string, unknown>>) =>
      runRequestBudgetAlert(
        { accountId: 'a', token: 't' },
        vi.fn(async () => ({ ok: true, json: async () => ({ data: rows }) })) as never,
        send,
        state
      );
    const bad = { route: '/slow', requests: 400, p95_ms: 3000, errors_5xx: 0 };
    const good = { route: '/slow', requests: 400, p95_ms: 100, errors_5xx: 0 };
    expect((await run([bad])).alerted).toBe(1);
    expect((await run([bad])).alerted).toBe(0); // hourly tick, same incident
    expect((await run([bad])).alerted).toBe(0);
    expect((await run([])).alerted).toBe(0); // no data is not recovery
    expect((await run([bad])).alerted).toBe(0);
    expect((await run([good])).alerted).toBe(0); // recovered: state cleared
    expect(saved).toEqual([]);
    expect((await run([bad])).alerted).toBe(1); // a NEW incident pages again
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('an alert that failed to go out is retried next tick', async () => {
    let saved: string[] = [];
    const state: AlertedStore = { get: async () => saved, put: async r => void (saved = r) };
    const outcomes = ['failed', 'sent'];
    const send = vi.fn(async () => outcomes.shift()) as never;
    const f = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ route: '/x', requests: 400, p95_ms: 3000, errors_5xx: 0 }] }),
    })) as never;
    expect(
      (await runRequestBudgetAlert({ accountId: 'a', token: 't' }, f, send, state)).alerted
    ).toBe(0);
    expect(
      (await runRequestBudgetAlert({ accountId: 'a', token: 't' }, f, send, state)).alerted
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
