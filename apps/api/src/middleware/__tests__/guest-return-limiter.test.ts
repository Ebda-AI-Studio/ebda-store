import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  guestReturnIpLimiter,
  guestReturnOrderLimiter,
  GUEST_RETURN_IP_MAX,
  GUEST_RETURN_ORDER_MAX,
} from '../security';

// Foundation criterion 19 / Ruling GUEST-RET-1: the guest return route is bounded per IP and per order.
// The real limiters + their in-process store; one route stands in for POST /public/returns/guest.
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/stores/:storeId/guest', guestReturnIpLimiter, guestReturnOrderLimiter, (_req, res) =>
    res.json({ ok: true })
  );
  await new Promise<void>(r => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const post = (ip: string, orderNumber: string, store = 's1') =>
  fetch(`${base}/stores/${store}/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ orderNumber, phone: '+201000000000' }),
  }).then(async r => ({ status: r.status, body: await r.text() }));

describe('guest return limiters', () => {
  it('trips per ORDER: many IPs guessing one order number are stopped at the cap', async () => {
    const results: number[] = [];
    for (let i = 0; i < GUEST_RETURN_ORDER_MAX + 2; i++)
      results.push((await post(`10.1.0.${i + 1}`, 'ORD-1')).status);
    expect(results.slice(0, GUEST_RETURN_ORDER_MAX).every(s => s === 200)).toBe(true);
    expect(results.slice(GUEST_RETURN_ORDER_MAX)).toEqual([429, 429]);
    // case and whitespace of the number are the same order
    expect((await post('10.1.9.9', ' ord-1 ')).status).toBe(429);
    // another order, and the same number in another store, are unaffected
    expect((await post('10.1.9.8', 'ORD-2')).status).toBe(200);
    expect((await post('10.1.9.7', 'ORD-1', 's2')).status).toBe(200);
  });

  it('trips per IP: one IP walking many order numbers is stopped at the cap', async () => {
    const results: number[] = [];
    for (let i = 0; i < GUEST_RETURN_IP_MAX + 1; i++)
      results.push((await post('10.2.0.1', `ORD-W${i}`)).status);
    expect(results.slice(0, GUEST_RETURN_IP_MAX).every(s => s === 200)).toBe(true);
    expect(results[GUEST_RETURN_IP_MAX]).toBe(429);
    // another IP is not affected
    expect((await post('10.2.0.2', 'ORD-W0')).status).toBe(200);
  });

  it('the 429 body is identical for both limits and names no order', async () => {
    const a = await post('10.3.0.1', 'ORD-Z');
    for (let i = 0; i < GUEST_RETURN_ORDER_MAX; i++) await post(`10.3.1.${i}`, 'ORD-Z');
    const byOrder = await post('10.3.2.1', 'ORD-Z');
    for (let i = 0; i < GUEST_RETURN_IP_MAX; i++) await post('10.3.3.1', `ORD-Q${i}`);
    const byIp = await post('10.3.3.1', 'ORD-Q-last');
    expect(a.status).toBe(200);
    expect(byOrder.status).toBe(429);
    expect(byIp.status).toBe(429);
    expect(byOrder.body).toBe(byIp.body);
    expect(byOrder.body).not.toContain('ORD-Z');
  });

  it('POST /returns/guest is wired behind both limiters', () => {
    const src = readFileSync(join(__dirname, '../../routes/public.routes.ts'), 'utf8');
    const at = src.indexOf("'/returns/guest'");
    expect(at).toBeGreaterThan(0);
    const head = src.slice(at, at + 400);
    expect(head).toContain('guestReturnIpLimiter');
    expect(head).toContain('guestReturnOrderLimiter');
  });
});
