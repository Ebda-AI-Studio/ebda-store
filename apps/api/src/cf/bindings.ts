// Cloudflare bindings, as the API sees them (R-EBDA-001).
//
// Declared structurally (not with @cloudflare/workers-types): the API package
// compiles against @types/node, and the two global type sets conflict. Only the
// methods the API calls are listed.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

export interface DurableObjectStubLike {
  [method: string]: (...args: never[]) => Promise<unknown>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface QueueProducerLike {
  send(message: unknown, opts?: { contentType?: string; delaySeconds?: number }): Promise<void>;
  sendBatch?(messages: Array<{ body: unknown; delaySeconds?: number }>): Promise<void>;
}

export interface ServiceBindingLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface RateLimitBindingLike {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface AiBindingLike {
  /** `options.signal` cancels the call (workers-types `AiOptions.signal`). */
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export interface CfBindings {
  HYPERDRIVE: { connectionString: string };
  /** Public caches (store/product payloads). Eventual consistency is fine for these. */
  KV_CACHE?: KVNamespaceLike;
  /** Strong-consistency state: token denylist, tv, lockout / MFA counters, auth limits. */
  AUTH_STATE?: DurableObjectNamespaceLike;
  /** One Durable Object per store (admin realtime, WebSocket hibernation). */
  STORE_REALTIME?: DurableObjectNamespaceLike;
  EMAIL_QUEUE?: QueueProducerLike;
  SMS_QUEUE?: QueueProducerLike;
  /** Coarse per-IP flood guard in front of Express (Workers Rate Limiting binding). */
  RATE_LIMITER?: RateLimitBindingLike;
  CF_VERSION_METADATA?: { id?: string; tag?: string };
  /** Service Binding to the storefront Worker (ebda-web): cache purge without a public host. */
  STOREFRONT?: ServiceBindingLike;
  /** Workers AI (search embeddings, bge-m3). Always remote, also in `wrangler dev`. */
  AI?: AiBindingLike;
  [name: string]: unknown;
}

let current: CfBindings | undefined;

/**
 * The Worker's `env`. The bindings are not request-scoped I/O (a KV namespace or a
 * Durable Object namespace may be used from any request), so the first fetch /
 * queue / scheduled call records it for the whole isolate.
 */
export function setCfBindings(env: CfBindings): void {
  current = env;
}

/** The Worker's bindings, or undefined outside a Worker (Node, vitest unit tests). */
export function cfBindings(): CfBindings | undefined {
  return current;
}

/** Test seam: forget the recorded bindings. */
export function clearCfBindings(): void {
  current = undefined;
}

// `ctx.waitUntil` IS request-scoped, so it travels on AsyncLocalStorage.
const waitUntilStore = new AsyncLocalStorage<(p: Promise<unknown>) => void>();

export function runWithWaitUntil<T>(waitUntil: (p: Promise<unknown>) => void, fn: () => T): T {
  return waitUntilStore.run(waitUntil, fn);
}

/**
 * Keep `p` alive past the response (Workers: `ctx.waitUntil`, 30 s grace). Outside a
 * Worker request the promise simply runs detached, as it always did on Node.
 */
export function cfWaitUntil(p: Promise<unknown>): void {
  const w = waitUntilStore.getStore();
  if (w) w(p.catch(() => undefined));
  else void p.catch(() => undefined);
}
