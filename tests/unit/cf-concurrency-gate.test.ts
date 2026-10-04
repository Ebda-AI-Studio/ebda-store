/** Bounds the request-bound Prisma clients per isolate (apps/api/src/cf/concurrency-gate.ts). */
import { describe, it, expect } from 'vitest';
import { ConcurrencyGate, GateTimeout } from '@api/cf/concurrency-gate';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('ConcurrencyGate', () => {
  it('lets `limit` through at once and queues the rest', async () => {
    const gate = new ConcurrencyGate(2, 1000);
    const r1 = await gate.acquire();
    await gate.acquire();
    expect(gate.inFlight).toBe(2);
    let third = false;
    const p3 = gate.acquire().then(rel => ((third = true), rel));
    await tick();
    expect(third).toBe(false);
    expect(gate.queued).toBe(1);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    expect(gate.inFlight).toBe(2); // the slot was handed over, not freed and re-taken
    r3();
  });

  it('serves waiters in arrival order', async () => {
    const gate = new ConcurrencyGate(1, 1000);
    const first = await gate.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map(n => gate.acquire().then(rel => (order.push(n), rel)));
    first();
    for (const w of waiters) (await w)();
    expect(order).toEqual([1, 2, 3]);
    expect(gate.inFlight).toBe(0);
  });

  it('rejects with GateTimeout after maxWaitMs and leaves the queue clean', async () => {
    const gate = new ConcurrencyGate(1, 30);
    const held = await gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(GateTimeout);
    expect(gate.queued).toBe(0);
    held();
    expect(gate.inFlight).toBe(0);
    // ...and the gate still works afterwards.
    (await gate.acquire())();
  });

  it('releasing twice frees one slot, not two', async () => {
    const gate = new ConcurrencyGate(1, 1000);
    const rel = await gate.acquire();
    rel();
    rel();
    expect(gate.inFlight).toBe(0);
    await gate.acquire();
    let second = false;
    void gate.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false); // the double release did not open a second slot
  });

  it('never exceeds the limit under a burst', async () => {
    const gate = new ConcurrencyGate(3, 5000);
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const rel = await gate.acquire();
        live++;
        peak = Math.max(peak, live);
        await new Promise(r => setTimeout(r, 2));
        live--;
        rel();
      })
    );
    expect(peak).toBe(3);
  });
});
