import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  couponAttemptLimiter,
  couponValidateDistinctLimiter,
  couponValidateLimiter,
} from '../security';

// The real limiters + their in-process store (no Redis in tests). Two routes stand in for
// POST /coupons/validate (couponValidateDistinctLimiter) and POST /orders/quote (couponAttemptLimiter).
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/validate', couponValidateDistinctLimiter, (_req, res) => res.json({ ok: true }));
  app.post('/quote', couponAttemptLimiter, (_req, res) => res.json({ ok: true }));
  await new Promise<void>(r => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const post = (path: string, ip: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }).then(r => r.status);

describe('couponAttemptLimiter (distinct codes per IP per window)', () => {
  it('never limits the same code repeated 50x on /orders/quote', async () => {
    for (let i = 0; i < 50; i++)
      expect(await post('/quote', '10.0.0.1', { couponCode: 'SAVE10' })).toBe(200);
  });

  it('treats case and whitespace variants as the same code', async () => {
    for (const c of ['Save10', ' SAVE10 ', 'save10']) {
      expect(await post('/quote', '10.0.0.9', { couponCode: c })).toBe(200);
    }
  });

  it('429s the 21st DISTINCT code, and a retry of that refused code is still refused', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push(await post('/quote', '10.0.0.2', { couponCode: `C${i}` }));
    expect(statuses.slice(0, 20).every(s => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(await post('/quote', '10.0.0.2', { couponCode: 'C20' })).toBe(429);
    // already-seen codes stay usable (a shopper re-quoting), new ones stay refused
    expect(await post('/quote', '10.0.0.2', { couponCode: 'C0' })).toBe(200);
    expect(await post('/quote', '10.0.0.2', { couponCode: 'C99' })).toBe(429);
  });

  it('does not count requests without a couponCode', async () => {
    for (let i = 0; i < 30; i++) {
      expect(await post('/quote', '10.0.0.3', {})).toBe(200);
      expect(await post('/quote', '10.0.0.3', { couponCode: '   ' })).toBe(200);
    }
    for (let i = 0; i < 20; i++)
      expect(await post('/quote', '10.0.0.3', { couponCode: `D${i}` })).toBe(200);
    expect(await post('/quote', '10.0.0.3', { couponCode: 'D20' })).toBe(429);
  });

  it('shares one distinct set with /coupons/validate', async () => {
    for (let i = 0; i < 12; i++)
      expect(await post('/validate', '10.0.0.4', { code: `V${i}` })).toBe(200);
    for (let i = 0; i < 8; i++)
      expect(await post('/quote', '10.0.0.4', { couponCode: `Q${i}` })).toBe(200);
    expect(await post('/quote', '10.0.0.4', { couponCode: 'NEW1' })).toBe(429);
    expect(await post('/validate', '10.0.0.4', { code: 'NEW2' })).toBe(429);
    // a code first seen on validate is a repeat on quote
    expect(await post('/quote', '10.0.0.4', { couponCode: 'V0' })).toBe(200);
  });

  it('keeps IPs independent', async () => {
    for (let i = 0; i < 25; i++) await post('/quote', '10.0.0.5', { couponCode: `E${i}` });
    expect(await post('/quote', '10.0.0.6', { couponCode: 'E0' })).toBe(200);
  });
});

// Wiring: every public route that evaluates a caller-supplied coupon code must carry the limiter.
describe('couponAttemptLimiter wiring', () => {
  it('guards POST /orders and POST /orders/quote in public.routes', async () => {
    const { default: router } = await import('../../routes/public.routes.js');
    const layers = (
      router as unknown as {
        stack: {
          route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
        }[];
      }
    ).stack;
    for (const path of ['/orders', '/orders/quote']) {
      const layer = layers.find(l => l.route?.path === path && l.route.methods.post);
      expect(layer, path).toBeDefined();
      expect(
        layer!.route!.stack.some(s => s.handle === couponAttemptLimiter),
        path
      ).toBe(true);
    }
  });
});

describe('couponValidateDistinctLimiter wiring', () => {
  it('guards POST /public/:storeId/coupons/validate alongside the request limiter', async () => {
    const { default: router } = await import('../../routes/coupon.routes.js');
    const layers = (
      router as unknown as {
        stack: {
          route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
        }[];
      }
    ).stack;
    const layer = layers.find(
      l => l.route?.path === '/public/:storeId/coupons/validate' && l.route.methods.post
    );
    expect(layer).toBeDefined();
    const handles = layer!.route!.stack.map(s => s.handle);
    expect(handles).toContain(couponValidateDistinctLimiter);
    expect(handles).toContain(couponValidateLimiter);
  });
});
