/**
 * issue 2064 — the global-limiter bypass for `POST /api/v1/inngest`
 * (global-rate-limit-skip.ts, Bypass 4) is safe only because the installed
 * Inngest SDK, in cloud mode with a signing key, answers 401 to a forged or
 * missing `x-inngest-signature` BEFORE running any function. Until now that
 * was asserted from reading the SDK source; this drives the REAL `serve`
 * handler from `inngest/express`, configured the way lib/inngest/client.ts
 * configures production (`isDev: false` + a signing key), so an SDK upgrade
 * that changes the behaviour turns this red instead of silently widening the
 * bypass.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Inngest } from 'inngest';
import { serve } from 'inngest/express';

function appWithRealHandler() {
  const ran = vi.fn();
  const client = new Inngest({
    id: 'ebda-api-test',
    isDev: false,
    signingKey: 'signkey-prod-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const fn = client.createFunction(
    { id: 'probe', triggers: [{ event: 'test/probe' }] },
    async () => {
      ran();
      return 'ran';
    }
  );
  const app = express();
  app.use(express.json());
  app.use('/api/v1/inngest', serve({ client, functions: [fn] }));
  return { app, ran };
}

const body = {
  event: { name: 'test/probe', data: {} },
  events: [{ name: 'test/probe', data: {} }],
  steps: {},
  ctx: { run_id: 'r1', attempt: 0, stack: { stack: [], current: 0 } },
};

describe('real Inngest serve handler in cloud mode (issue 2064)', () => {
  it('401s a POST with a FORGED x-inngest-signature and runs nothing', async () => {
    const { app, ran } = appWithRealHandler();
    const res = await request(app)
      .post('/api/v1/inngest?fnId=ebda-api-test-probe&stepId=step')
      .set('x-inngest-signature', 'x')
      .send(body);
    expect(res.status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });

  it('401s a POST with NO signature and runs nothing', async () => {
    const { app, ran } = appWithRealHandler();
    const res = await request(app)
      .post('/api/v1/inngest?fnId=ebda-api-test-probe&stepId=step')
      .send(body);
    expect(res.status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });
});
