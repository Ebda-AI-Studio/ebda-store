import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';

/**
 * G5 on real workerd: the JobGate Durable Object (leases, fencing, debounce) and the real
 * `JobWorkflow` class from the built Worker (a no-DB job completes; an unknown job errors without
 * retrying). Needs no database: `heartbeat` opens no step.
 */
interface Gate {
  acquire(limit: number, ttlMs: number): Promise<string | null>;
  renew(token: string, ttlMs: number): Promise<boolean>;
  release(token: string): Promise<void>;
  touch(timeoutMs: number): Promise<string>;
  isLatest(token: string, timeoutMs: number): Promise<boolean>;
}
const e = env as unknown as {
  JOB_GATE: { idFromName(n: string): unknown; get(id: unknown): Gate };
  JOBS_WORKFLOW: {
    create(o: { id: string; params: unknown }): Promise<{ id: string }>;
    get(id: string): Promise<{ status(): Promise<{ status: string; error?: unknown }> }>;
  };
};
const gate = (name: string) => e.JOB_GATE.get(e.JOB_GATE.idFromName(`${name}-${Math.random()}`));

describe('JobGate (concurrency lease)', () => {
  it('grants at most `limit` leases and frees one on release', async () => {
    const g = gate('limit');
    const a = await g.acquire(2, 60_000);
    const b = await g.acquire(2, 60_000);
    expect(a && b).toBeTruthy();
    expect(await g.acquire(2, 60_000)).toBeNull();
    await g.release(a!);
    expect(await g.acquire(2, 60_000)).not.toBeNull();
  });

  it('an expired lease is reclaimed by the next acquire, and the old holder is fenced out', async () => {
    const g = gate('expiry');
    const old = await g.acquire(1, 1);
    await new Promise(r => setTimeout(r, 15));
    const fresh = await g.acquire(1, 60_000);
    expect(fresh).not.toBeNull();
    expect(await g.renew(old!, 60_000)).toBe(false);
    expect(await g.renew(fresh!, 60_000)).toBe(true);
  });

  it('renewal keeps a lease alive past its original TTL', async () => {
    const g = gate('renew');
    const t = await g.acquire(1, 30);
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 15));
      expect(await g.renew(t!, 30)).toBe(true);
    }
    expect(await g.acquire(1, 60_000)).toBeNull(); // ~60 ms in, original TTL long gone
  });

  it('debounce: only the newest token proceeds, a stream past the timeout still gets one run', async () => {
    const g = gate('debounce');
    const t1 = await g.touch(60_000);
    const t2 = await g.touch(60_000);
    expect(await g.isLatest(t1, 60_000)).toBe(false);
    expect(await g.isLatest(t2, 60_000)).toBe(true);
    await new Promise(r => setTimeout(r, 15));
    expect(await g.isLatest(t1, 5)).toBe(true); // burst older than the 5 ms timeout
  });
});

async function finished(id: string): Promise<{ status: string; error?: unknown }> {
  const inst = await e.JOBS_WORKFLOW.get(id);
  for (let i = 0; i < 100; i++) {
    const s = await inst.status();
    if (['complete', 'errored', 'terminated'].includes(s.status)) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('workflow did not finish');
}

describe('JobWorkflow (the real class in the built Worker)', () => {
  it('runs a registered job to completion', async () => {
    const id = `t-heartbeat-${Date.now()}`;
    await e.JOBS_WORKFLOW.create({
      id,
      params: { fn: 'heartbeat', event: { name: 'inngest/scheduled.timer', id: 'e1', data: {} } },
    });
    expect((await finished(id)).status).toBe('complete');
  });

  it('an unknown job errors (non-retryable) instead of looping', async () => {
    const id = `t-ghost-${Date.now()}`;
    await e.JOBS_WORKFLOW.create({
      id,
      params: { fn: 'no-such-job', event: { name: 'x/y', id: 'e2', data: {} } },
    });
    expect((await finished(id)).status).toBe('errored');
  });
});
