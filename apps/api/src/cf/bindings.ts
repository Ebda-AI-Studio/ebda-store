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
  get(id: unknown, options?: { locationHint?: string }): DurableObjectStubLike;
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

export interface WorkflowBindingLike {
  /** Throws when an instance with this id already exists. */
  create(opts: { id: string; params: unknown }): Promise<{ id: string }>;
}

export interface EmailBindingLike {
  send(message: {
    from: string | { email: string; name?: string };
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/** RPC surface of the shared identity service (apps/accounts/src/index.ts `Accounts`). */
export interface AccountsRpc {
  isRevoked?(sid: string): Promise<boolean>;
  revokeSession?(sid: string, reason: string): Promise<void>;
  revokeUser?(userId: string, reason: string): Promise<void>;
  setStatus?(
    userId: string,
    status: 'active' | 'inactive' | 'suspended',
    reason: string
  ): Promise<void>;
  getAccountState?(userId: string): Promise<AccountState | null>;
  resendVerification?(email: string): Promise<void>;
  /** Store deletion: remove the store's integrator clients, secrets and trail (idempotent). */
  deleteStoreClients?(storeId: string): Promise<{ clients: number }>;
  eraseUser?(userId: string, requestId?: string): Promise<{ erased: boolean; remaining: number }>;
  exportUser?(userId: string): Promise<Record<string, unknown[]>>;
  setRole?(
    userId: string,
    role: 'store_admin' | 'staff',
    reason: string,
    ifCurrentRole?: 'store_admin' | 'staff'
  ): Promise<boolean>;
  inviteUser?(input: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'store_admin' | 'staff';
    language?: 'en' | 'ar';
    storeName?: string;
  }): Promise<
    | { id: string; created: true }
    | { id: string; created: false; emailVerified: boolean; role: AccountState['role'] }
  >;
  forgotPassword?(email: string): Promise<void>;
  createUser?(input: {
    id?: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    language?: 'en' | 'ar';
  }): Promise<{ id: string } | null>;
}

export interface AccountState {
  id: string;
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaEnrolledAt: string | null;
  status: 'active' | 'inactive' | 'suspended';
  role: 'customer' | 'store_admin' | 'super_admin' | 'staff';
  firstName: string;
  lastName: string;
  phone: string | null;
  language: string;
}

/** R2 bucket, as the CI sink uses it (conditional put returns null when the precondition fails). */
export interface R2BucketCasLike {
  get(
    key: string
  ): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; etag: string } | null>;
  put(
    key: string,
    value: string | Uint8Array,
    opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }
  ): Promise<unknown | null>;
}

/** Analytics Engine dataset binding. */
export interface AnalyticsEngineLike {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface CfBindings {
  HYPERDRIVE: { connectionString: string };
  /** Public caches (store/product payloads). Eventual consistency is fine for these. */
  KV_CACHE?: KVNamespaceLike;
  /** Strong-consistency state: token denylist, tv, lockout / MFA counters, auth limits. */
  AUTH_STATE?: DurableObjectNamespaceLike;
  /** One Durable Object per store (admin realtime, WebSocket hibernation). */
  STORE_REALTIME?: DurableObjectNamespaceLike;
  /** One SQLite Durable Object per store (Phase 0 spike, flag-gated: lib/store-backend.ts). */
  STORE_DO?: DurableObjectNamespaceLike;
  /**
   * Vectorize index of the product vectors of stores on their Durable Object (1024 dims, cosine, namespace = store id), bound as
   * `PRODUCT_VECTORS` in wrangler.jsonc (Ruling CF-VEC-1). Optional in the type so a missing binding fails soft: the DO product indexer
   * skips loudly and the storefront search falls back to the keyword leg.
   */
  PRODUCT_VECTORS?: import('@ebda-src/repo').VectorizeLike;
  /** R2 bucket for StoreDO backups (prefix store-do-backups/). */
  STORE_BACKUPS?: unknown;
  /** Store -> Ebda WhatsApp events (contract 2026-10-24): lib/wa/events.ts. */
  WA_EVENTS_QUEUE?: QueueProducerLike;
  /** Cloudflare Email Service `send_email` binding (G6): every outbound email (services/mail-transport.ts). */
  EMAIL?: EmailBindingLike;
  /** Background jobs (G5): Workflows binding, the jobs Queue and the concurrency/debounce gate DO. */
  JOBS_WORKFLOW?: WorkflowBindingLike;
  JOBS_QUEUE?: QueueProducerLike;
  JOB_GATE?: DurableObjectNamespaceLike;
  /** One SQLite Durable Object per store: its recurring jobs as an alarm (src/cf/store-schedule.ts). */
  STORE_SCHEDULE?: DurableObjectNamespaceLike;
  /** Customer Intelligence capture (lib/ci): events in, R2 `ebda-ci` + Analytics Engine out. */
  CI_EVENTS_QUEUE?: QueueProducerLike;
  CI_BUCKET?: R2BucketCasLike;
  CI_OUTCOMES?: AnalyticsEngineLike;
  EMAIL_QUEUE?: QueueProducerLike;
  SMS_QUEUE?: QueueProducerLike;
  /** Coarse per-IP flood guard in front of Express (Workers Rate Limiting binding). */
  RATE_LIMITER?: RateLimitBindingLike;
  /** Anonymous public READS only: per-IP, 300 / 60 s per location (see middleware/public-read-limit.ts). */
  PUBLIC_IP_LIMITER?: RateLimitBindingLike;
  /** Anonymous public READS only: per-tenant, 6000 / 60 s per location. */
  PUBLIC_TENANT_LIMITER?: RateLimitBindingLike;
  CF_VERSION_METADATA?: { id?: string; tag?: string };
  /** Service Binding to the storefront Worker (ebda-web): cache purge without a public host. */
  STOREFRONT?: ServiceBindingLike;
  /** Service Binding to the shared identity service (ebda-accounts): JWKS over fetch, `isRevoked`/`revokeUser` over RPC. */
  ACCOUNTS?: ServiceBindingLike & AccountsRpc;
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
