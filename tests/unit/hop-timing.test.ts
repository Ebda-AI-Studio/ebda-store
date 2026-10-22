// Per-hop timings are operator-only and log-only: never in a response (timing oracle).
import { describe, it, expect, vi, afterEach } from 'vitest';
const info = vi.hoisted(() => vi.fn());
vi.mock('../../apps/api/src/lib/logger', () => ({ default: { info } }));
import { hop, hopTiming, markHop } from '../../apps/api/src/lib/hop-timing';

const SECRET = ['operator', 'token', 'x'.repeat(20)].join('-');
function run(headers: Record<string, string>, body: () => Promise<void>) {
  const set: Record<string, unknown> = {};
  const handlers: Record<string, () => void> = {};
  const res: any = {
    statusCode: 200,
    headersSent: false,
    getHeader: () => undefined,
    setHeader: (k: string, v: string) => (set[k] = v),
    once: (e: string, f: () => void) => (handlers[e] = f),
  };
  return new Promise<{ set: Record<string, unknown> }>(resolve => {
    hopTiming({ headers, method: 'GET', path: '/x' } as any, res, () => {
      body().then(() => {
        handlers.finish?.();
        resolve({ set });
      });
    });
  });
}
afterEach(() => {
  info.mockClear();
  delete process.env.HOP_TIMING_TOKEN;
  vi.restoreAllMocks();
});

describe('hop timing is operator-only and log-only', () => {
  it('a normal response never carries per-hop Server-Timing, with or without the header', async () => {
    process.env.HOP_TIMING_TOKEN = SECRET;
    for (const headers of [
      {},
      { 'x-hop-timing': '1' },
      { 'x-hop-timing': 'wrong' },
      { 'x-hop-timing': SECRET },
    ]) {
      const { set } = await run(headers, async () => {
        await hop('do-lockout-get', async () => 1);
      });
      expect(set['Server-Timing']).toBeUndefined();
    }
  });
  it('without the secret configured (or a short one) the feature is off', async () => {
    const log = info;
    await run({ 'x-hop-timing': 'anything' }, async () => {});
    process.env.HOP_TIMING_TOKEN = 'short';
    await run({ 'x-hop-timing': 'short' }, async () => {});
    expect(log).not.toHaveBeenCalled();
  });
  it('a wrong or missing token logs nothing', async () => {
    process.env.HOP_TIMING_TOKEN = SECRET;
    const log = info;
    await run({ 'x-hop-timing': 'nope' }, async () => {});
    await run({}, async () => {});
    expect(log).not.toHaveBeenCalled();
  });
  it('the exact operator token writes ONE structured log line with named hops', async () => {
    process.env.HOP_TIMING_TOKEN = SECRET;
    const log = info;
    await run({ 'x-hop-timing': SECRET }, async () => {
      markHop('routes');
      await hop('do-ratelimit-hit', async () => 1);
    });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line.hopTiming).toBe(true);
    expect(JSON.stringify(line)).not.toContain('/x');
    expect(line.hops.map((h: unknown[]) => h[0])).toEqual(['at-routes', 'do-ratelimit-hit']);
  });
  it('a failing hop still propagates its error', async () => {
    await expect(hop('db-x', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );
  });
});
