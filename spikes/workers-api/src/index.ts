import { Hono } from 'hono';
import { runRequest, type DbEnv, type Reply, type RequestResult } from './db';

interface Env extends DbEnv {
  DEBUG_HEADERS?: string;
  [secret: string]: unknown;
}

const app = new Hono<{ Bindings: Env }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hostOf = (req: Request) => req.headers.get('host') ?? new URL(req.url).host;
// Spike stand-in for auth: FWB derives userId from the verified JWT.
const userIdOf = (req: Request) => {
  const u = req.headers.get('x-ebda-user-id');
  return u && UUID_RE.test(u) ? u : undefined;
};

function respond(c: any, r: RequestResult): Response {
  // COMMIT has already happened. Deferred (external) work runs after, outside any tx.
  for (const fn of r.deferred) c.executionCtx.waitUntil(fn().catch(() => {}));
  const h = new Headers({
    'content-type': 'application/json',
    'x-ebda-tx-ms': r.txMs.toFixed(1),
    ...r.reply.headers,
  });
  return new Response(JSON.stringify(r.reply.body), { status: r.reply.status, headers: h });
}
const run = (c: any, handler: Parameters<typeof runRequest>[3]) =>
  runRequest(c.env, hostOf(c.req.raw), userIdOf(c.req.raw), handler, {
    wantPid: c.env.DEBUG_HEADERS === '1',
  });

// Public catalogue read (mirrors FWB public storefront product list; no pricing engine).
app.get('/products', async c => {
  const r = await run(c, async (tx, { storeId }) => {
    const products = await tx.product.findMany({
      where: { storeId, active: true }, // defense-in-depth, like FWB's explicit storeId filters
      orderBy: { name: 'asc' },
      select: { id: true, storeId: true, name: true, pricePiastres: true },
    });
    return { status: 200, body: { storeId, products } };
  });
  return respond(c, r);
});

// Cart write: create cart if missing, add/increment item, all in the request tx.
app.post('/cart/items', async c => {
  const sessionId = c.req.header('x-session-id');
  const input = (await c.req.json().catch(() => null)) as {
    productId?: string;
    quantity?: number;
  } | null;
  const qty = input?.quantity ?? 1;
  if (!sessionId || !input?.productId || !Number.isInteger(qty) || qty < 1 || qty > 100) {
    return c.json({ error: 'bad_request' }, 400);
  }
  const r = await run(c, async (tx, { storeId, userId }) => {
    // RLS hides other tenants' products, so a cross-tenant productId is a clean 404.
    const product = await tx.product.findFirst({
      where: { id: input.productId!, storeId, active: true },
      select: { id: true },
    });
    if (!product) return { status: 404, body: { error: 'product_not_found' } };
    const cart = await tx.cart.upsert({
      where: { storeId_sessionId: { storeId, sessionId } },
      create: { id: crypto.randomUUID(), storeId, sessionId, userId },
      update: {},
      select: { id: true },
    });
    await tx.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId: product.id } },
      create: { id: crypto.randomUUID(), cartId: cart.id, productId: product.id, quantity: qty },
      update: { quantity: { increment: qty } },
    });
    const items = await tx.cartItem.findMany({
      where: { cartId: cart.id },
      select: { productId: true, quantity: true },
      orderBy: { productId: 'asc' },
    });
    return { status: 200, body: { cartId: cart.id, items } };
  });
  return respond(c, r);
});

// ---- payment webhook ----
const hex = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(s)) return null;
  const out = new Uint8Array(new ArrayBuffer(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
async function verifyHmac(secret: string, rawBody: string, sigHex: string): Promise<boolean> {
  const sig = hex(sigHex.replace(/^sha256=/, ''));
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(rawBody)); // constant-time
}

app.post('/webhooks/payments/:provider', async c => {
  const provider = c.req.param('provider').toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(provider)) return c.json({ error: 'unknown_provider' }, 404);
  const secret = c.env[`WEBHOOK_SECRET_${provider.toUpperCase().replace(/-/g, '_')}`];
  if (typeof secret !== 'string') return c.json({ error: 'unknown_provider' }, 404);
  const rawBody = await c.req.text(); // RAW bytes as text, BEFORE any JSON parse
  const sig = c.req.header('x-signature');
  if (!sig || !(await verifyHmac(secret, rawBody, sig)))
    return c.json({ error: 'invalid_signature' }, 401);
  let evt: { eventId?: unknown; cartId?: unknown };
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  if (typeof evt.eventId !== 'string' || typeof evt.cartId !== 'string')
    return c.json({ error: 'bad_payload' }, 400);
  const { eventId, cartId } = evt;

  const r = await run(c, async (tx, { storeId, defer }) => {
    // Inbox idempotency: unique (provider, event_id); ON CONFLICT DO NOTHING => replay inserts 0 rows.
    const ins = await tx.webhookEvent.createMany({
      data: [{ id: crypto.randomUUID(), storeId, provider, eventId, rawBody }],
      skipDuplicates: true,
    });
    if (ins.count === 0) return { status: 200, body: { ok: true, duplicate: true } };
    const upd = await tx.cart.updateMany({
      where: { id: cartId, storeId, status: 'open' },
      data: { status: 'paid', paidAt: new Date() },
    });
    await tx.webhookEvent.updateMany({
      where: { provider, eventId },
      data: { status: upd.count ? 'processed' : 'ignored' },
    });
    // External side effects (email/WhatsApp/Inngest) go AFTER commit, never in the tx:
    defer(async () => {
      /* e.g. fetch(notifier) — none in this spike */
    });
    return { status: 200, body: { ok: true, duplicate: false, cartMarkedPaid: upd.count === 1 } };
  });
  return respond(c, r);
});

app.notFound(c => c.json({ error: 'not_found' }, 404));
app.onError((e, c) => {
  console.error('request failed', e instanceof Error ? e.message : e);
  return c.json({ error: 'internal' }, 500);
});

export default app;
