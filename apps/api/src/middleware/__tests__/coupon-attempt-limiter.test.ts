import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { couponAttemptLimiter, couponValidateLimiter } from '../security';

// The real limiters + their in-process store (no Redis in tests). Two routes stand in for
// POST /coupons/validate (couponValidateLimiter) and POST /orders/quote (couponAttemptLimiter).
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/validate', couponValidateLimiter, (_req, res) => res.json({ ok: true }));
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

describe('couponAttemptLimiter', () => {
  it('429s the 21st quote request carrying a couponCode from one IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push(await post('/quote', '10.0.0.1', { couponCode: `C${i}` }));
    expect(statuses.slice(0, 20).every(s => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('does not count requests without a couponCode (blank/absent/non-string)', async () => {
    for (let i = 0; i < 30; i++) {
      expect(await post('/quote', '10.0.0.2', {})).toBe(200);
      expect(await post('/quote', '10.0.0.2', { couponCode: '   ' })).toBe(200);
    }
    // budget untouched: a full 20 coupon attempts still pass afterwards
    for (let i = 0; i < 20; i++)
      expect(await post('/quote', '10.0.0.2', { couponCode: 'X' })).toBe(200);
    expect(await post('/quote', '10.0.0.2', { couponCode: 'X' })).toBe(429);
  });

  it('shares one bucket with /coupons/validate', async () => {
    for (let i = 0; i < 12; i++)
      expect(await post('/validate', '10.0.0.3', { code: 'A' })).toBe(200);
    for (let i = 0; i < 8; i++)
      expect(await post('/quote', '10.0.0.3', { couponCode: 'A' })).toBe(200);
    // 20 used across both endpoints -> both now refuse
    expect(await post('/quote', '10.0.0.3', { couponCode: 'A' })).toBe(429);
    expect(await post('/validate', '10.0.0.3', { code: 'A' })).toBe(429);
  });

  it('keeps IPs independent', async () => {
    expect(await post('/quote', '10.0.0.4', { couponCode: 'A' })).toBe(200);
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
