/**
 * GHSA-mrhx-c7xc-m3w5 regression (Ruling ITEST-11), through BOTH zod entry points.
 *
 * Evidence (measured, 1,000,000 elements that all fail z.array(z.string())):
 *   zod (v4) uncapped 276 ms / 1M issues / +471 MB;   zod (v4) .max(100)  0 ms / 1 issue / +0 MB   <- the 4.6.6 patch
 *   zod/v3   uncapped 684 ms / 1M issues / +311 MB;   zod/v3   .max(100) 476 ms / 1M+1 issues / +307 MB
 * The patch (`capSize`) touches only src/v4/core; src/v3 is byte-identical between 4.6.5 and 4.6.7. Our code
 * imports `zod/v3`, so a `.max()` does not bound the work there: the API-wide guard in front of every schema
 * (middleware/request-shape-guard.ts) is what does. This file pins both halves.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z as z4 } from 'zod';
import { z as z3 } from 'zod/v3';
import {
  API_BODY_LIMITS,
  requestShapeGuard,
  API_JSON_BODY_LIMIT_BYTES,
} from '@api/middleware/request-shape-guard';
import { bodyShapeViolation } from '@ebda/shared/request-guard';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

const heapMb = () => process.memoryUsage().heapUsed / 1e6;

function measure<T>(fn: () => T): { out: T; ms: number; mb: number } {
  (globalThis as { gc?: () => void }).gc?.();
  const h0 = heapMb();
  const t0 = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t0, mb: heapMb() - h0 };
}

const HUGE = new Array(1_000_000).fill(1); // numbers where strings are expected: every element fails

function through(body: unknown, headers: Record<string, string> = {}) {
  const req = { body, headers } as unknown as Request;
  let status = 0;
  let payload: any;
  let next = false;
  const res = {
    status(c: number) {
      status = c;
      return this;
    },
    json(b: unknown) {
      payload = b;
      return this;
    },
  } as unknown as Response;
  requestShapeGuard(req, res, () => {
    next = true;
  });
  return { status, payload, next };
}

describe('the dependency half: zod v4 stays patched', () => {
  it('a size-capped v4 array refuses a 1M-element input without parsing the elements', () => {
    const r = measure(() => z4.array(z4.string()).max(100).safeParse(HUGE));
    expect(r.out.success).toBe(false);
    expect(r.out.error!.issues).toHaveLength(1); // 4.6.5 produced 1,000,000
    expect(r.ms).toBeLessThan(200);
    expect(r.mb).toBeLessThan(25);
  });
});

describe('the boundary half: the guard stands in front of BOTH entry points', () => {
  for (const [name, schema] of [
    ['zod (v4)', z4.array(z4.string()).max(100)],
    ['zod/v3', z3.array(z3.string()).max(100)],
  ] as const) {
    it(`${name}: a huge array body is refused by the guard before the schema is ever run`, () => {
      let schemaRuns = 0;
      const guarded = measure(() => {
        const r = through({ items: HUGE });
        if (r.next) {
          schemaRuns++;
          (schema as { safeParse(x: unknown): unknown }).safeParse(HUGE);
        }
        return r;
      });
      expect(guarded.out.status).toBe(400);
      expect(guarded.out.payload.error.code).toBe('REQUEST_TOO_COMPLEX');
      expect(schemaRuns).toBe(0);
      expect(guarded.ms).toBeLessThan(250);
      expect(guarded.mb).toBeLessThan(60);
    });

    it(`${name}: at the largest array the guard admits, the schema parse stays small`, () => {
      const atCap = new Array(API_BODY_LIMITS.maxArrayLength).fill(1);
      expect(through({ items: atCap }).next).toBe(true);
      const r = measure(() => (schema as { safeParse(x: unknown): unknown }).safeParse(atCap));
      expect(r.ms).toBeLessThan(250);
      expect(r.mb).toBeLessThan(60);
    });
  }
});

describe('requestShapeGuard', () => {
  it('uses the same byte cap as the JSON parser in app.ts', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../apps/api/src/app.ts'), 'utf8');
    expect(src).toContain("express.json({ limit: '10mb' })");
    expect(API_JSON_BODY_LIMIT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('passes ordinary bodies, raw Buffers and empty bodies', () => {
    expect(through({ name: 'x', items: [1, 2, 3], nested: { a: [{ b: 1 }] } }).next).toBe(true);
    expect(through(Buffer.from('{"a":1}')).next).toBe(true);
    expect(through(undefined).next).toBe(true);
  });

  it('refuses a declared body over the byte cap with 413', () => {
    const r = through({}, { 'content-length': String(API_JSON_BODY_LIMIT_BYTES + 1) });
    expect(r.status).toBe(413);
    expect(r.payload.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(r.next).toBe(false);
  });

  it('accepts exactly the array cap and refuses one more', () => {
    expect(through({ a: new Array(API_BODY_LIMITS.maxArrayLength).fill(0) }).next).toBe(true);
    const r = through({ a: new Array(API_BODY_LIMITS.maxArrayLength + 1).fill(0) });
    expect(r.status).toBe(400);
  });

  it('refuses hostile depth without overflowing the stack, and too many nodes', () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 100_000; i++) {
      deep.n = {};
      deep = deep.n;
    }
    expect(bodyShapeViolation(root, API_BODY_LIMITS)).toBe('nested too deeply');
    const wide = { list: Array.from({ length: 9_000 }, () => ({})) };
    const many = { a: wide, b: wide, c: wide, d: wide, e: wide };
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) big['k' + i] = many;
    expect(bodyShapeViolation(big, API_BODY_LIMITS)).toBe('too many fields');
  });
});

describe('over HTTP, as app.ts wires it (json parser, then the guard, then the route)', () => {
  it('answers 400 for an oversized array and never reaches the route; a normal body gets through', async () => {
    let routeRuns = 0;
    const app = express();
    app.use(express.json({ limit: API_JSON_BODY_LIMIT_BYTES }));
    app.use(requestShapeGuard);
    app.post('/echo', (_req, res) => {
      routeRuns++;
      res.json({ ok: true });
    });
    const bad = await request(app)
      .post('/echo')
      .send({ items: new Array(API_BODY_LIMITS.maxArrayLength + 1).fill(1) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('REQUEST_TOO_COMPLEX');
    expect(routeRuns).toBe(0);
    const ok = await request(app)
      .post('/echo')
      .send({ items: [1, 2, 3] });
    expect(ok.status).toBe(200);
    expect(routeRuns).toBe(1);
  });
});
