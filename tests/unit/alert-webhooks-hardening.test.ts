/**
 * F-06 (security audit 2026-10-14): the alerts bridge must fail CLOSED in
 * production when ALERTS_WEBHOOK_TOKEN is unset (it used to accept any
 * payload), and Sentry issue webhooks must alert only on a NEW issue or a
 * triggered alert rule — not on resolved / assigned / archived.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: m.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({ config: { nodeEnv: 'test' } }));

const ORIGINAL = { token: process.env.ALERTS_WEBHOOK_TOKEN, env: process.env.NODE_ENV };

async function appWith(token: string | undefined, nodeEnv: string) {
  vi.resetModules();
  if (token === undefined) delete process.env.ALERTS_WEBHOOK_TOKEN;
  else process.env.ALERTS_WEBHOOK_TOKEN = token;
  process.env.NODE_ENV = nodeEnv;
  const routes = (await import('@api/routes/alert-webhooks.routes')).default;
  const app = express();
  app.use(express.json());
  app.use('/hooks', routes);
  return app;
}

beforeEach(() => m.sendAlert.mockClear());
afterEach(() => {
  if (ORIGINAL.token === undefined) delete process.env.ALERTS_WEBHOOK_TOKEN;
  else process.env.ALERTS_WEBHOOK_TOKEN = ORIGINAL.token;
  process.env.NODE_ENV = ORIGINAL.env;
});

describe('alerts bridge token', () => {
  it('rejects every call in production when the token is unset', async () => {
    const app = await appWith(undefined, 'production');
    const res = await request(app).post('/hooks/generic').send({ title: 'x', body: 'y' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('alerts_not_configured');
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it('still allows an unset token outside production (dev convenience)', async () => {
    const app = await appWith(undefined, 'development');
    const res = await request(app).post('/hooks/generic').send({ title: 'x', body: 'y' });
    expect(res.status).toBe(200);
  });

  it('requires the token when it is set', async () => {
    const app = await appWith('a'.repeat(64), 'production');
    expect((await request(app).post('/hooks/generic').send({ title: 'x' })).status).toBe(401);
    const ok = await request(app)
      .post('/hooks/generic')
      .set('x-alerts-token', 'a'.repeat(64))
      .send({ title: 'x', body: 'y' });
    expect(ok.status).toBe(200);
  });

  it('S7: refuses ?token= (header only), even with the right value', async () => {
    const app = await appWith('a'.repeat(64), 'production');
    const res = await request(app)
      .post(`/hooks/generic?token=${'a'.repeat(64)}`)
      .send({ title: 'x', body: 'y' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('token_in_query_refused');
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it('S7: reads the secret per request (rotation needs no redeploy)', async () => {
    const app = await appWith('a'.repeat(64), 'production');
    process.env.ALERTS_WEBHOOK_TOKEN = 'c'.repeat(64);
    const old = await request(app)
      .post('/hooks/generic')
      .set('x-alerts-token', 'a'.repeat(64))
      .send({ title: 'x' });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post('/hooks/generic')
      .set('x-alerts-token', 'c'.repeat(64))
      .send({ title: 'x' });
    expect(fresh.status).toBe(200);
  });
});

describe('sentry issue webhook actions', () => {
  const T = 'b'.repeat(64);
  const issue = {
    title: 'TypeError',
    web_url: 'https://sentry.io/i/1',
    level: 'error',
    project: { slug: 'ebda-api' },
  };

  it.each(['resolved', 'assigned', 'archived', 'unresolved'])('ignores action %s', async action => {
    const app = await appWith(T, 'production');
    const res = await request(app)
      .post('/hooks/sentry')
      .set('x-alerts-token', T)
      .send({ action, data: { issue } });
    expect(res.status).toBe(200);
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it('alerts on a created issue', async () => {
    const app = await appWith(T, 'production');
    await request(app)
      .post('/hooks/sentry')
      .set('x-alerts-token', T)
      .send({ action: 'created', data: { issue } });
    expect(m.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'p1',
        source: 'sentry.ebda-api',
        title: 'sentry: TypeError',
      })
    );
  });

  it('alerts on a triggered alert rule (data.event)', async () => {
    const app = await appWith(T, 'production');
    await request(app)
      .post('/hooks/sentry')
      .set('x-alerts-token', T)
      .send({ action: 'triggered', data: { event: { ...issue, title: 'Spike' } } });
    expect(m.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'sentry.ebda-api', title: 'sentry: Spike' })
    );
  });
});
