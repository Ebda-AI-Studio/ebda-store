import { it, expect } from 'vitest';
import { AMELIA, SECRET, call, hmacHex } from './helpers';

// Not an isolation test: records sequential (uncontended) per-request timings on workerd -> pgbouncer -> pg, all on localhost.
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return `p50=${q(0.5).toFixed(1)}ms p95=${q(0.95).toFixed(1)}ms min=${s[0].toFixed(1)}ms`; };

async function bench(name: string, mk: (i: number) => Promise<Response>) {
  for (let i = 0; i < 5; i++) await mk(i); // warmup
  const total: number[] = [], tx: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now(); const r = await mk(i + 5); total.push(performance.now() - t);
    expect(r.status).toBe(200); tx.push(Number(r.headers.get('x-ebda-tx-ms')));
  }
  console.log(`[timing] ${name}: end-to-end ${stats(total)} | in-handler tx(incl. connect+BEGIN..COMMIT) ${stats(tx)}`);
}

it('sequential per-request timings', async () => {
  const t0 = performance.now(); await call(AMELIA.host, '/products'); const cold = performance.now() - t0;
  console.log(`[timing] first request in isolate (wasm init + cold connect): ${cold.toFixed(0)}ms`);
  await bench('GET /products', () => call(AMELIA.host, '/products'));
  const s = crypto.randomUUID();
  await bench('POST /cart/items', () => call(AMELIA.host, '/cart/items', { method: 'POST', body: JSON.stringify({ productId: 'a0000000-0000-4000-8000-000000000001' }), headers: { 'x-session-id': s } }));
  await bench('POST /webhooks/payments/fakepay', async () => {
    const raw = JSON.stringify({ eventId: `evt_${crypto.randomUUID()}`, cartId: 'none' });
    return call(AMELIA.host, '/webhooks/payments/fakepay', { method: 'POST', body: raw, headers: { 'x-signature': await hmacHex(SECRET, raw) } });
  });
});
