import { describe, it, expect, vi } from 'vitest';
import { waBridgeTiming } from '@api/lib/observability/wa-bridge-timing';

describe('waBridgeTiming', () => {
  it('logs duration in ms when response finishes', async () => {
    const logger = { info: vi.fn() };
    const req: any = { path: '/store-catalog', method: 'GET', query: { storeId: 'abc' } };
    const res: any = { on: vi.fn(), statusCode: 200 };
    const next = vi.fn();

    waBridgeTiming(logger as any)(req, res, next);
    expect(next).toHaveBeenCalled();
    // Simulate finish event
    const finishHandler = res.on.mock.calls.find((c: any) => c[0] === 'finish')?.[1];
    expect(finishHandler).toBeDefined();
    // Sleep well clear of the assertion floor. `setTimeout(n)` guarantees only
    // "not before n", and the elapsed value is computed from a clock whose
    // resolution and coalescing can round the observed gap just under n — this
    // asserted >= 10 after sleeping exactly 10 and failed CI at 9. The point of
    // the assertion is that durationMs reflects REAL elapsed time rather than
    // zero, so a wide margin keeps that meaning without racing the timer.
    await new Promise(r => setTimeout(r, 50));
    finishHandler();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/store-catalog',
        method: 'GET',
        status: 200,
        durationMs: expect.any(Number),
      }),
      'wa-bridge timing'
    );
    expect(logger.info.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(20);
  });
});
