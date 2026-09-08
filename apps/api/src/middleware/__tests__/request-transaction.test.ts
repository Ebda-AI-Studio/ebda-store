/**
 * Request-transaction lifecycle — COMMIT BEFORE RESPOND.
 *
 * Every assertion here is about ORDER, observed on a real HTTP socket: the
 * suite runs a real Express app on an ephemeral port, drives it with `fetch`,
 * and records two kinds of event into one shared array —
 *
 *   - `commit` / `rollback`  — pushed by a FAKE transaction that stands in for
 *     `runInTenantContext` (no database in a unit test), and
 *   - `flush`                — pushed from `res.on('finish')`, i.e. the moment
 *     the response was handed to the socket.
 *
 * The whole defect this file guards is the relative order of those two events.
 * Asserting a status code alone cannot see it: the old middleware returned the
 * same 201 for a write that never committed. So every test names the order it
 * expects, and the two lanes are asserted to have OPPOSITE orders on purpose —
 * a change that silently moves a route from the buffered lane to the streaming
 * lane (or back) reddens a test rather than shipping quietly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { runRequestInTransaction } from '../request-transaction';

/** Ordered log of tx + socket events for one request. */
let events: string[] = [];

beforeEach(() => {
  events = [];
});

/**
 * Stand-in for `runInTenantContext`. Runs the body, then records the outcome
 * the way a real interactive transaction would: `commit` when the body
 * resolves, `rollback` when it rejects.
 *
 * @param failCommit make the COMMIT itself fail — the silent-lost-write shape
 *                   the old middleware could not report.
 */
function fakeTx(failCommit = false) {
  return async (body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (err) {
      events.push('rollback');
      throw err;
    }
    if (failCommit) {
      events.push('commit-failed');
      throw new Error('COMMIT failed: connection lost');
    }
    events.push('commit');
  };
}

interface AppOpts {
  failCommit?: boolean;
  /** Opens the transaction — override to simulate a tx that never opens. */
  open?: (body: () => Promise<void>) => Promise<unknown>;
}

/** Build an app whose `/probe` route is wrapped exactly as a store-scoped route is. */
function buildApp(
  handler: (req: Request, res: Response, next: NextFunction) => void,
  opts: AppOpts = {}
) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.on('finish', () => events.push('flush'));
    next();
  });
  app.use((_req, res, next) => {
    runRequestInTransaction(res, next, opts.open ?? fakeTx(opts.failCommit), { test: true });
  });
  app.get('/probe', handler);
  // Mirrors the real app's terminal error handler.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: err.message } });
  });
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// BUFFERED lane — the fix
// ---------------------------------------------------------------------------

describe('buffered lane: commit happens BEFORE the response is flushed', () => {
  it('a 201 JSON response commits first, then flushes', async () => {
    const app = buildApp((_req, res) => {
      res.status(201).json({ ok: true });
    });
    const body = await withServer(app, async base => {
      const r = await fetch(`${base}/probe`);
      expect(r.status).toBe(201);
      return r.json();
    });
    expect(body).toEqual({ ok: true });
    // THE assertion. Under the old finish-based middleware this was
    // ['flush', 'commit'].
    expect(events).toEqual(['commit', 'flush']);
  });

  it('a 200 res.send(string) response commits first, then flushes', async () => {
    const app = buildApp((_req, res) => {
      res.type('text/csv').send('a,b\n1,2\n');
    });
    const text = await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    expect(text).toBe('a,b\n1,2\n');
    expect(events).toEqual(['commit', 'flush']);
  });

  it('a 204 with no body commits first, then flushes', async () => {
    const app = buildApp((_req, res) => {
      res.status(204).end();
    });
    const status = await withServer(app, async base => (await fetch(`${base}/probe`)).status);
    expect(status).toBe(204);
    expect(events).toEqual(['commit', 'flush']);
  });

  it('a 302 redirect commits first, then flushes', async () => {
    const app = buildApp((_req, res) => {
      res.redirect('/elsewhere');
    });
    const status = await withServer(
      app,
      async base => (await fetch(`${base}/probe`, { redirect: 'manual' })).status
    );
    expect(status).toBe(302);
    expect(events).toEqual(['commit', 'flush']);
  });

  it('a 4xx COMMITS (unchanged behaviour) — a validation failure is not a rollback', async () => {
    const app = buildApp((_req, res) => {
      res.status(400).json({ error: 'bad' });
    });
    const status = await withServer(app, async base => (await fetch(`${base}/probe`)).status);
    expect(status).toBe(400);
    expect(events).toEqual(['commit', 'flush']);
    expect(events).not.toContain('rollback');
  });
});

// ---------------------------------------------------------------------------
// 5xx ⇒ ROLLBACK — existing, load-bearing behaviour
// ---------------------------------------------------------------------------

describe('5xx still rolls back', () => {
  it('a handler that throws rolls back and still returns the 500 body', async () => {
    const app = buildApp(() => {
      throw new Error('boom');
    });
    const res = await withServer(app, async base => {
      const r = await fetch(`${base}/probe`);
      return { status: r.status, body: await r.json() };
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: { message: 'boom' } });
    // Rollback lands BEFORE the client is answered, and the handler's own 500
    // is still the response — not swallowed by the rollback.
    expect(events).toEqual(['rollback', 'flush']);
  });

  it('a route that sets headers then throws rolls back and answers 500', async () => {
    const app = buildApp((_req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
      res.setHeader('Content-Type', 'text/csv');
      throw new Error('late failure');
    });
    const out = await withServer(app, async base => {
      const r = await fetch(`${base}/probe`);
      return { status: r.status, body: await r.text() };
    });
    expect(out.status).toBe(500);
    expect(out.body).toContain('late failure');
    expect(events).toEqual(['rollback', 'flush']);
    // NOT asserted here: the surviving `Content-Type: text/csv`. Express's
    // `res.json` only sets a Content-Type when none is present, so a handler
    // that pre-set one keeps it on the error response — pre-existing Express
    // behaviour on a code path this change does not touch. It is stripped
    // only where THIS module discards a response (the commit-failure test
    // below), because there the discard is ours to make honest.
  });

  it('an explicit res.status(503) rolls back', async () => {
    const app = buildApp((_req, res) => {
      res.status(503).json({ error: 'unavailable' });
    });
    const status = await withServer(app, async base => (await fetch(`${base}/probe`)).status);
    expect(status).toBe(503);
    expect(events).toEqual(['rollback', 'flush']);
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE: a failed COMMIT can no longer hide behind a 2xx
// ---------------------------------------------------------------------------

describe('a COMMIT that fails becomes a 500 the client actually sees', () => {
  it('turns a would-be 201 into a 500 instead of a silent lost write', async () => {
    const app = buildApp(
      (_req, res) => {
        res.status(201).json({ orderId: 'ord_1' });
      },
      { failCommit: true }
    );
    const out = await withServer(app, async base => {
      const r = await fetch(`${base}/probe`);
      return { status: r.status, body: await r.json() };
    });
    // Under the old middleware this was 201 + {orderId} over a write that
    // never landed: the customer was told it worked and it did not.
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ success: false });
    expect(out.body).not.toMatchObject({ orderId: 'ord_1' });
    expect(events).toEqual(['commit-failed', 'flush']);
  });

  it('strips the discarded response’s Content-Disposition from the 500', async () => {
    const app = buildApp(
      (_req, res) => {
        res.setHeader('Content-Disposition', 'attachment; filename="export.csv"');
        res.type('text/csv').send('a,b\n');
      },
      { failCommit: true }
    );
    const headers = await withServer(app, async base => {
      const r = await fetch(`${base}/probe`);
      expect(r.status).toBe(500);
      return r.headers.get('content-disposition');
    });
    expect(headers).toBeNull();
  });

  it('a transaction that never opens still yields a clean 500', async () => {
    const app = buildApp(
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
      { open: () => Promise.reject(new Error('could not start transaction')) }
    );
    const status = await withServer(app, async base => (await fetch(`${base}/probe`)).status);
    expect(status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// STREAMING lane — the documented, enforced exclusion
// ---------------------------------------------------------------------------

describe('streaming lane: escalated, not truncated, still commit-after-flush', () => {
  it('res.write() escalates — the full body arrives and commit lands AFTER flush', async () => {
    const chunks = ['header\n', 'row-1\n', 'row-2\n', 'row-3\n'];
    const app = buildApp(async (_req, res) => {
      res.setHeader('Content-Type', 'text/csv');
      for (const c of chunks) {
        res.write(c);
        // Force each chunk into its own tick so a "commit early" bug would
        // truncate the body rather than racing invisibly.
        await new Promise(r => setTimeout(r, 5));
      }
      res.end();
    });
    const text = await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    // NOT TRUNCATED — the whole point of excluding this shape.
    expect(text).toBe(chunks.join(''));
    // And the exclusion itself is asserted: this lane keeps the OLD order.
    expect(events).toEqual(['flush', 'commit']);
  });

  it('a stream longer than a typical handler still delivers every byte', async () => {
    // 200 chunks spread over ~400ms: long enough that a commit-first design
    // would have closed the transaction (and any mid-stream query with it)
    // well before the last chunk.
    const app = buildApp(async (_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      for (let i = 0; i < 200; i++) {
        res.write(`${i}\n`);
        if (i % 20 === 0) await new Promise(r => setTimeout(r, 40));
      }
      res.end();
    });
    const text = await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('0');
    expect(lines[199]).toBe('199');
    expect(events).toEqual(['flush', 'commit']);
  });

  it('write-then-more-writes: the transaction is still open at the last chunk', async () => {
    // Records a marker at the moment the last chunk is written. The commit
    // must come after it — i.e. a mid-stream query would still be inside the
    // tenant transaction (and still carry the RLS GUC).
    const app = buildApp(async (_req, res) => {
      res.write('a');
      await new Promise(r => setTimeout(r, 20));
      events.push('last-chunk-written');
      res.write('b');
      res.end();
    });
    await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    expect(events.indexOf('last-chunk-written')).toBeLessThan(events.indexOf('commit'));
  });

  it('a readable piped into res escalates via res.write', async () => {
    const { Readable } = await import('stream');
    const app = buildApp((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      Readable.from(['x', 'y', 'z']).pipe(res);
    });
    const text = await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    expect(text).toBe('xyz');
    expect(events).toEqual(['flush', 'commit']);
  });

  it('res.sendFile escalates to the streaming lane', async () => {
    const app = buildApp((_req, res) => {
      res.sendFile(__filename);
    });
    const text = await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    // The file is this test file — assert it arrived whole, not truncated.
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('res.sendFile escalates to the streaming lane');
    expect(events).toEqual(['flush', 'commit']);
  });

  it('res.download escalates to the streaming lane', async () => {
    const app = buildApp((_req, res) => {
      res.download(__filename, 'probe.txt');
    });
    const out = await withServer(app, async base => {
      const r = await fetch(`${base}/probe`);
      return { disposition: r.headers.get('content-disposition'), text: await r.text() };
    });
    expect(out.disposition).toContain('attachment');
    expect(out.text.length).toBeGreaterThan(1000);
    expect(events).toEqual(['flush', 'commit']);
  });

  it('res.flushHeaders() escalates (SSE / long-poll shape)', async () => {
    const app = buildApp(async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      await new Promise(r => setTimeout(r, 20));
      res.end('data: done\n\n');
    });
    const text = await withServer(app, async base => (await fetch(`${base}/probe`)).text());
    expect(text).toBe('data: done\n\n');
    expect(events).toEqual(['flush', 'commit']);
  });
});

// ---------------------------------------------------------------------------
// Client disconnect
// ---------------------------------------------------------------------------

describe('client disconnect', () => {
  it('a client that aborts mid-handler commits, it does not roll back', async () => {
    let released!: () => void;
    const gate = new Promise<void>(r => {
      released = r;
    });
    const app = buildApp(async (_req, res) => {
      await gate;
      res.json({ ok: true });
    });
    await withServer(app, async base => {
      const ac = new AbortController();
      const p = fetch(`${base}/probe`, { signal: ac.signal }).catch(() => undefined);
      await new Promise(r => setTimeout(r, 30));
      ac.abort();
      await p;
      // Let the socket close propagate, then release the handler.
      await new Promise(r => setTimeout(r, 50));
      released();
      await new Promise(r => setTimeout(r, 50));
    });
    expect(events).toContain('commit');
    expect(events).not.toContain('rollback');
  });
});
