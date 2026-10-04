/**
 * Bounds how many request-bound Prisma clients one isolate holds at once.
 *
 * Each client owns an instance of Prisma's wasm query compiler, about 3.3 MB of linear
 * memory (measured on Node: 31 live clients = +108 MB external; no growth across 120
 * sequential create / query / disconnect cycles, so the cost is per LIVE client, not a
 * leak). A Workers isolate has a 128 MB limit shared by every request it serves, so an
 * unbounded burst would get the isolate killed mid-request (error 1102) instead of
 * degrading. The gate turns that into a short queue and, past `maxWaitMs`, a 503 with
 * Retry-After that the edge can send to another isolate. Slots are released when the
 * request's client is about to close, i.e. after its deferred work has drained.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    readonly limit: number,
    readonly maxWaitMs: number
  ) {}

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  /** Resolve with a `release` function once a slot is free; reject with GateTimeout after maxWaitMs. */
  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        clearTimeout(timer);
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new GateTimeout(this.maxWaitMs));
      }, this.maxWaitMs);
      this.waiters.push(grant);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next)
        next(); // hand the slot straight to the next waiter (active stays the same)
      else this.active--;
    };
  }
}

export class GateTimeout extends Error {
  constructor(readonly waitedMs: number) {
    super(`no database client slot free after ${waitedMs} ms`);
  }
}
