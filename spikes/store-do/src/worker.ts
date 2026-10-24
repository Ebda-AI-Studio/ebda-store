import { StoreDO, type Env } from './store-do';

export { StoreDO };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });

/** Flag: the DO backend serves ONLY ids listed in STORE_DO_ENABLED_IDS (default empty). */
export const enabledIds = (env: Pick<Env, 'STORE_DO_ENABLED_IDS'>): Set<string> =>
  new Set(
    (env.STORE_DO_ENABLED_IDS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );

// Routes (spike): /s/<storeId>/{products,cart/items,orders,__seed}; /health.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health')
      return json({ ok: true, storage_backend: 'store-do-spike', enabled: enabledIds(env).size });
    const m = url.pathname.match(/^\/s\/([^/]+)\/(.+)$/);
    if (!m) return json({ error: 'NOT_FOUND' }, 404);
    const [, storeId, rest] = m;
    if (!enabledIds(env).has(storeId)) return json({ error: 'STORE_NOT_ENABLED' }, 404); // never default-to-first
    const stub = env.STORE_DO.get(env.STORE_DO.idFromName(storeId));
    const headers = { 'x-store-backend': 'do' };
    const reply = (
      r: { ok: true; data: unknown } | { ok: false; code: string; status: number },
      okStatus = 200
    ) => (r.ok ? json(r.data, okStatus, headers) : json({ error: r.code }, r.status, headers));

    if (rest === 'products' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 24) || 24, 1), 100);
      return reply(await stub.listProducts(storeId, limit));
    }
    const sid = req.headers.get('x-session-id');
    if (rest === 'cart/items' && req.method === 'POST') {
      if (!sid) return json({ error: 'MISSING_SESSION' }, 400, headers);
      const b = (await req.json()) as { productId?: string; quantity?: number; variantId?: string };
      if (!b.productId || !Number.isInteger(b.quantity ?? 1) || (b.quantity ?? 1) < 1)
        return json({ error: 'VALIDATION' }, 400, headers);
      return reply(await stub.addCartItem(storeId, sid, b.productId, b.quantity ?? 1, b.variantId));
    }
    if (rest === 'orders' && req.method === 'POST') {
      if (!sid) return json({ error: 'MISSING_SESSION' }, 400, headers);
      return reply(await stub.createOrder(storeId, sid), 201);
    }
    if (rest === '__seed' && req.method === 'POST') {
      // Seeding is an operator action: requires the spike token, never open.
      if (!env.SEED_TOKEN || req.headers.get('authorization') !== `Bearer ${env.SEED_TOKEN}`)
        return json({ error: 'FORBIDDEN' }, 403);
      return reply(await stub.seed((await req.json()) as Parameters<StoreDO['seed']>[0]));
    }
    return json({ error: 'NOT_FOUND' }, 404, headers);
  },
};
