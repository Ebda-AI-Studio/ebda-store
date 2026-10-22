import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Run several independent middlewares CONCURRENTLY and continue only when ALL of them have called
 * `next()` without error. Used for rate limiters whose counters live behind a network hop (a
 * Durable Object round trip each): chained one after another they cost N round trips, run
 * together they cost one (measured 2026-10-22: two sequential `rl-hit` hops of 110 ms warm,
 * 0.8-1.4 s on a cold shard).
 *
 * Nothing is weakened: every middleware still runs on every request, the first to answer (a 429)
 * ends it exactly as in the chained form, a middleware error is forwarded once, and the request
 * proceeds only if none of them blocked. The middlewares must be independent (no one reads what
 * another wrote on `req`), which holds for keyed counters.
 */
export function inParallel(...mws: RequestHandler[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    let pending = mws.length;
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      if (err) {
        settled = true;
        next(err);
        return;
      }
      if (--pending === 0) {
        settled = true;
        next();
      }
    };
    for (const mw of mws) {
      try {
        void mw(req, res, done);
      } catch (e) {
        done(e);
      }
    }
  };
}
