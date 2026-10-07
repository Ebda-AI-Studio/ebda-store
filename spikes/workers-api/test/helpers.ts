import { env, exports } from 'cloudflare:workers';
import { makePrisma, setTenantGucs, type Tx } from '../src/db';

export const AMELIA = {
  host: 'amelia.ebda.app',
  id: '11111111-1111-4111-8111-111111111111',
  prefix: 'Amelia',
  n: 3,
};
export const RIVAL = {
  host: 'rival.ebda.app',
  id: '22222222-2222-4222-8222-222222222222',
  prefix: 'Rival',
  n: 2,
};
export const SECRET = 'dev-only-not-a-real-secret';

export const call = (host: string, path: string, init: RequestInit = {}) =>
  (exports as any).default.fetch(new Request(`https://${host}${path}`, init)) as Promise<Response>;

/** Run fn in a tx on a fresh client, optionally scoped like the Worker does. */
export async function rawTx<T>(fn: (tx: Tx) => Promise<T>, storeId?: string): Promise<T> {
  const prisma = makePrisma(env as any);
  try {
    return await prisma.$transaction(
      async tx => {
        if (storeId) await setTenantGucs(tx, { storeId });
        return fn(tx);
      },
      { maxWait: 5000, timeout: 10000 }
    );
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

export async function hmacHex(secret: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)));
  return [...s].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Bounded-concurrency map (pgbouncer max_client_conn=200). */
export async function pmap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}
