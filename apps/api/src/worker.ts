/**
 * The Ebda API as a Cloudflare Worker (R-EBDA-001, SP4 Stage 1).
 *
 * Express (app.ts, shared with the Node shell in index.ts) runs through
 * `handleAsNodeRequest` (`cloudflare:node`, `nodejs_compat`). Everything that is
 * Worker-specific lives in this file and src/cf/:
 *
 *   - a POOL of Prisma clients per isolate, each leased to one request at a time and reused (the
 *     engine, ~3.3 MB, is built once per client, not per request), over a leased driver adapter.
 *     The pg connection (pool of one, from the Node-era pooler) is per request and opened lazily: workerd
 *     forbids reusing an I/O object (a socket) from another request (experiment B6/B9). One client
 *     shared by concurrent requests hangs, see packages/database/src/client-pool.ts. The
 *     connection is closed, and the client returned, through `ctx.waitUntil`, after the post-commit
 *     deferred work (`deferAfterTenantCommit`) has drained on it.
 *   - the client's real IP: Cloudflare's `cf-connecting-ip` overwrites X-Forwarded-For,
 *     so `trust proxy` = 1 yields the connecting address and a spoofed header is dropped; with no
 *     `cf-connecting-ip` the caller's X-Forwarded-For is deleted. A storefront server render's signed
 *     shopper address replaces it on the anonymous storefront reads only (cf/ssr-client-ip.ts, Ruling RL-SSR-IP-6).
 *   - Queue, Cron and Durable Object entry points (consumers, scheduled, AuthState,
 *     StoreRealtime), and the WebSocket upgrade for realtime (`/socket.io/`).
 */
import { handleAsNodeRequest } from 'cloudflare:node';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createServer } from 'node:http';
import app from './app';
import {
  createPostgresRemovedClient,
  currentReachLabel,
  postgresRemovedWhere,
  withReachLabel,
  postgresReaches,
  runWithRequestDb,
  trackPostgresReaches,
} from '@ebda/database';
import { awaitDeferredWork } from './lib/after-tenant-commit';
import { redis } from './services/redis.service';
import { SentryService } from './services/sentry.service';
import logger from './lib/logger';
import { warnMissingStoreResolveBindings } from './middleware/store-resolve-native';
import { runWithWaitUntil, setCfBindings, type CfBindings } from './cf/bindings';
import { instrumentBindings } from './lib/io-tally';
import { dispatchedEvents, trackDispatches } from './lib/jobs/dispatch';
import { handleQueueBatch, type MessageBatchLike } from './cf/queues';
import { parkIfFrozen, type ParkableBatch } from './cf/queue-freeze';
import { handleStoreEventsBatch } from './lib/wa/store-events-queue';
import { STORE_EVENTS_DLQ, STORE_EVENTS_QUEUE } from './lib/wa/config';
import { runScheduled } from './cf/cron';
import { routeCutover } from './cf/cutover';
import { runJobWorkflow } from './lib/jobs/run-workflow';
import type { JobParams } from './lib/jobs/start';
import { sendAlert } from './services/alerts.service';
import { servePublicEdge, stripFillMarker, type CacheLike } from './cf/public-edge-cache';
import { readEdgeGensForHit } from './lib/edge-gens';
import { resolveClientAddress, shouldWarnNoSecret } from './cf/ssr-client-ip';
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  sendCodeMail,
  storesForUser,
  storeLive,
  storeActive,
  type CodeMail,
  type NoticeMail,
  sendNoticeMail,
  type StoreClaim,
} from './lib/identity-directory';
import { waBridge, ownerTools } from './lib/wa/bridge';
import { listStoreMembers, memberRole } from './lib/store-members';
import { isPlatformOrigin } from './lib/cors-cache';
import { config } from './config';
import { assertEmbeddingConfig } from './lib/search/embedding-provider';
import { assertWhatsAppLinkConfig } from './lib/wa/config';
import { assertCiCaptureConfig, CI_EVENTS_DLQ, CI_EVENTS_QUEUE } from './lib/ci/config';
import { handleCiEventsBatch } from './lib/ci/sink';
import * as Sentry from '@sentry/cloudflare';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@ebda/shared';

export { AuthState } from './cf/auth-state';
export { StoreRealtime } from './cf/store-realtime';
export { StoreDO } from './cf/store-do/store-do';
export { JobGate } from './cf/job-gate';
export { StoreSchedule } from './cf/store-schedule-do';

// The Worker's `process.on('unhandledRejection')` (index.ts, Node): a rejection nobody awaited
// (a late socket error from a closing pg connection, a fire-and-forget that failed) is logged with
// its stack and reported, never silently dropped, and does not surface as an uncaught error.
(
  globalThis as unknown as {
    addEventListener(
      type: string,
      fn: (e: { reason?: unknown; preventDefault?(): void }) => void
    ): void;
  }
).addEventListener('unhandledrejection', event => {
  logger.error({ err: event.reason }, 'Unhandled rejection');
  if (event.reason instanceof Error) {
    SentryService.captureException(event.reason, { tags: { type: 'unhandledRejection' } });
  }
  event.preventDefault?.();
});

/** workerd's ExecutionContext, structurally. */
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException?(): void;
}

// `handleAsNodeRequest` dispatches to the http.Server listening on this port. The server
// is an emulation inside the isolate, not a real socket.
const PORT = 4000;
createServer(app).listen(PORT);

/** Upper bound for the post-response drain (Workers grants 30 s after the response). */
const DRAIN_BUDGET_MS = 25_000;

let redisReady: Promise<void> | undefined;

/**
 * NEON-ZERO N-17 (Ruling NZ-D23): the Worker has no Postgres (no Postgres binding). Anything that still reaches the
 * exported `prisma` gets a client that throws POSTGRES_REMOVED at once (no socket, no hang). The first hit per isolate is
 * logged and raises a P1 alert; every hit is also an error response, so a missed path is seen in Sentry and by the caller.
 */
let postgresRemovedReported = false;
function reportPostgresRemoved(err: Error): void {
  if (postgresRemovedReported) return;
  postgresRemovedReported = true;
  const where = postgresRemovedWhere(err, currentReachLabel());
  logger.error(
    { err: err.message, caller: where.caller, frames: where.frames },
    '[database] POSTGRES_REMOVED: a Prisma call reached the Worker'
  );
  Sentry.captureException(err, {
    tags: { site: 'postgres-removed', caller: where.caller },
    extra: { frames: where.frames },
  });
  void sendAlert({
    level: 'p1',
    scope: 'platform',
    source: 'api.worker.postgres_removed',
    title: `POSTGRES_REMOVED: a Prisma call reached the Worker (${where.caller})`,
    body: `${err.message} Caller: ${where.caller}. The path must be ported to the StoreDO / D1 (NEON-ZERO).\n${where.frames.join('\n')}`,
  }).catch(() => undefined);
}

/** Drop a client-supplied `x-ebda-backend` (the retired Phase 0 opt-in) before anything reads the request. */
export function stripBackendHeader(request: Request): Request {
  if (!request.headers.has('x-ebda-backend')) return request;
  const headers = new Headers(request.headers);
  headers.delete('x-ebda-backend');
  return new Request(request, { headers });
}

let embeddingConfigChecked = false;
let whatsAppConfigChecked = false;

function prepare(env: CfBindings): void {
  // Remote bindings tallied per request for Server-Timing + the call-count budgets (lib/io-tally.ts); memoised per env.
  setCfBindings(instrumentBindings(env));
  // Test only (workers-test route sweep): count every access to the Postgres client. Never set on a deployed Worker.
  if (env.DEV_STATS === '1') {
    trackPostgresReaches(true);
    trackDispatches(true);
  }
  // Fail loud on a semantic-search config with no provider (cached on success only, like the
  // role guard: a throwing isolate 500s every request until the config is fixed or rolled back).
  if (!embeddingConfigChecked) {
    assertEmbeddingConfig(logger);
    embeddingConfigChecked = true;
  }
  // The WhatsApp link needs SUITE_BUYER_KEY_SECRET; fail loud here, not on the first order.
  if (!whatsAppConfigChecked) {
    assertWhatsAppLinkConfig(env);
    assertCiCaptureConfig(env);
    whatsAppConfigChecked = true;
  }
  warnMissingStoreResolveBindings(env);
  // No sockets to open: this only flips redis.service to "available" over AuthState + KV.
  redisReady ??= redis.connect();
  const deployment = env.CF_VERSION_METADATA?.id;
  if (deployment && !process.env.CF_DEPLOYMENT_ID) process.env.CF_DEPLOYMENT_ID = deployment;
}

/**
 * Run `fn` with everything a Worker invocation needs: the bindings recorded, `waitUntil` on
 * AsyncLocalStorage and the Postgres-removed Prisma client (any use throws POSTGRES_REMOVED), released
 * after the deferred work drains. Used by fetch, queue and scheduled alike.
 */
async function withWorkerContext<T>(
  env: CfBindings,
  ctx: Ctx,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  prepare(env);
  // Work the request handed to `cfWaitUntil` (a verification email, a webhook fan-out, ...) runs on
  // THIS request's context, which is released only after it has settled.
  const floating = new Set<Promise<unknown>>();
  const waitUntil = (p: Promise<unknown>): void => {
    floating.add(p);
    void p.finally(() => floating.delete(p));
    ctx.waitUntil(p);
  };
  const drainFloating = async (): Promise<void> => {
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    while (floating.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...floating]),
        new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
  };
  return runWithWaitUntil(waitUntil, () =>
    runWithRequestDb(() => createPostgresRemovedClient(reportPostgresRemoved), fn, {
      waitUntil: p => ctx.waitUntil(p),
      signal,
      // Post-commit work runs inside this request's context and must finish before it closes.
      beforeDisconnect: () => awaitDeferredWork(DRAIN_BUDGET_MS).then(drainFloating),
    })
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/socket.io/` WebSocket upgrade -> the user's StoreRealtime Durable Object. The user id comes
 * from the handshake query (`uid`), which is UNVERIFIED: the DO authenticates the token itself
 * (through the API's `authenticate` middleware) and refuses it unless it belongs to that user.
 * The Origin must be a platform origin, as socket.io's CORS check was (cross-site WebSocket
 * hijacking: the cookie rides the upgrade).
 */
async function routeRealtime(request: Request, env: CfBindings): Promise<Response> {
  const ns = env.STORE_REALTIME;
  if (!ns) return new Response('realtime not configured', { status: 503 });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json(
      {
        success: false,
        error: { code: 'WEBSOCKET_REQUIRED', message: 'Use transports: ["websocket"]' },
      },
      { status: 400 }
    );
  }
  const origin = request.headers.get('origin');
  if (
    !origin ||
    !isPlatformOrigin(origin, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    })
  ) {
    return Response.json(
      { success: false, error: { code: 'CORS_ORIGIN_NOT_ALLOWED', message: 'Origin not allowed' } },
      { status: 403 }
    );
  }
  const uid = new URL(request.url).searchParams.get('uid') ?? '';
  if (!UUID_RE.test(uid)) {
    return Response.json(
      { success: false, error: { code: 'BAD_REQUEST', message: 'uid is required' } },
      { status: 400 }
    );
  }
  const headers = new Headers(request.headers);
  headers.set('x-realtime-user', uid.toLowerCase());
  const stub = ns.get(ns.idFromName(`user:${uid.toLowerCase()}`)) as unknown as {
    fetch(r: Request): Promise<Response>;
  };
  return stub.fetch(new Request(request, { headers }));
}

/**
 * Coarse per-IP flood guard in front of Express: the Workers Rate Limiting binding (cheap,
 * approximate, per location). Exact limits stay in Express (AuthState-backed). Inngest and
 * health probes are exempt; a binding error fails OPEN.
 */
async function floodGuard(
  env: CfBindings,
  path: string,
  ip: string | null
): Promise<Response | null> {
  if (!env.RATE_LIMITER || path === '/health') return null;
  if (!ip) return null;
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (success) return null;
  } catch {
    return null;
  }
  return Response.json(
    {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
    },
    { status: 429, headers: { 'retry-after': '60' } }
  );
}

async function handle(incoming: Request, env: CfBindings, ctx: Ctx): Promise<Response> {
  // The backend of a store is server-side state only (Ruling CF-BACKEND-1): the retired Phase 0 opt-in header never gets in.
  // Ruling RL-SSR-IP-6: the forward headers never reach Express; X-Forwarded-For is the one address limiters key on.
  const secret =
    (env as { REVALIDATE_SECRET?: unknown }).REVALIDATE_SECRET ?? process.env.REVALIDATE_SECRET;
  if (shouldWarnNoSecret(secret)) {
    logger.error(
      'SSR client address OFF: REVALIDATE_SECRET is not set on ebda-api, so no forwarded shopper address is trusted and every storefront render is charged to the storefront Worker (Ruling RL-SSR-IP-6)'
    );
  }
  const { request, ip: clientIp } = await resolveClientAddress(
    stripBackendHeader(incoming),
    secret
  );
  const path = new URL(request.url).pathname;
  // Test only: the Postgres-client accesses since the last reset (workers-test/route-sweep.test.ts, cron group).
  if (path === '/__dev/pg-reaches' && env.DEV_STATS === '1') {
    const reset = new URL(request.url).searchParams.get('reset') === '1';
    return Response.json({ reaches: postgresReaches(reset) });
  }
  // Test only: run every cron job body + the Postgres-adjacent queue messages (workers-test/route-sweep.test.ts, cron group).
  if (path === '/__dev/run-jobs' && request.method === 'POST' && env.DEV_STATS === '1') {
    return withWorkerContext(env, ctx, async () => {
      const { runEveryJobBody } = await import('./lib/jobs/dev-run-all.js');
      return Response.json(await runEveryJobBody());
    });
  }
  // Test only: run the jobs one event triggers, inline (workers-test/merchant-orders-do.test.ts, the CSV import job body).
  if (path === '/__dev/run-event' && request.method === 'POST' && env.DEV_STATS === '1') {
    return withWorkerContext(env, ctx, async () => {
      const { runEventJobs } = await import('./lib/jobs/dev-run-all.js');
      const body = (await request.json()) as { name: string; data: Record<string, unknown> };
      return Response.json({ jobs: await runEventJobs(body.name, body.data ?? {}) });
    });
  }
  // Test only: apply one WhatsApp store event as the ebda-store-events consumer does (merchant-orders-do.test.ts, COD outcome).
  if (path === '/__dev/wa-store-event' && request.method === 'POST' && env.DEV_STATS === '1') {
    return withWorkerContext(env, ctx, async () => {
      const { handleStoreEvent } = await import('./lib/wa/store-events-consumer.js');
      return Response.json({ result: await handleStoreEvent(await request.json()) });
    });
  }
  // Test only: the job events this isolate dispatched (workers-test/money-path.test.ts counts order/created).
  if (path === '/__dev/dispatched' && env.DEV_STATS === '1') {
    return Response.json({ events: dispatchedEvents() });
  }
  // Test only: run every cron job body + the Postgres-adjacent queue messages (workers-test/route-sweep.test.ts, cron group).
  if (path === '/__dev/run-jobs' && request.method === 'POST' && env.DEV_STATS === '1') {
    return withWorkerContext(env, ctx, async () => {
      const { runEveryJobBody } = await import('./lib/jobs/dev-run-all.js');
      return Response.json(await runEveryJobBody());
    });
  }
  // Dev/test only (DEV_STATS=1, never set in wrangler.jsonc): create a store through StoreService.create (N-18's pg-unreachable test).
  if (path === '/__dev/create-store' && request.method === 'POST' && env.DEV_STATS === '1') {
    const body = (await request.json()) as {
      ownerId: string;
      name: string;
      slug?: string;
      operator?: boolean;
    };
    const res = await withWorkerContext(env, ctx, async () => {
      const { StoreService } = await import('./services/store.service.js');
      const store = await StoreService.create(
        body.ownerId,
        { name: body.name, slug: body.slug },
        { platformOperator: body.operator === true }
      );
      return Response.json({ id: (store as { id: string }).id });
    });
    return res;
  }
  // Dev/test only (DEV_STATS=1, never set in wrangler.jsonc): create a store through StoreService.create (N-18's pg-unreachable test).
  if (path === '/__dev/create-store' && request.method === 'POST' && env.DEV_STATS === '1') {
    const body = (await request.json()) as {
      ownerId: string;
      name: string;
      slug?: string;
      operator?: boolean;
    };
    const res = await withWorkerContext(env, ctx, async () => {
      const { StoreService } = await import('./services/store.service.js');
      const store = await StoreService.create(
        body.ownerId,
        { name: body.name, slug: body.slug },
        { platformOperator: body.operator === true }
      );
      return Response.json({ id: (store as { id: string }).id });
    });
    return res;
  }
  // Cutover admin surface (docs/runbooks/cutover-cf.md): bearer-checked before the StoreDO sees it.
  const cutover = await routeCutover(request, env);
  if (cutover) return cutover;
  const flooded = await floodGuard(env, path, clientIp);
  if (flooded) return flooded;
  if (path === '/socket.io/' || path === '/socket.io') {
    prepare(env);
    // The upgrade is authenticated in the DO via the API; the Express app is not involved.
    return routeRealtime(request, env);
  }
  const origin = async (req: Request): Promise<Response> => {
    return withWorkerContext(
      env,
      ctx,
      () =>
        withReachLabel(`http ${req.method} ${new URL(req.url).pathname}`, () =>
          handleAsNodeRequest(PORT, req, env, ctx)
        ),
      req.signal
    );
  };

  // Ruling EDGE-API-1: anonymous public catalogue reads are answered from the Workers Cache API while their
  // cache generations are unchanged (cf/public-edge-cache.ts). Everything else, and any doubt, goes to Express.
  const edgeCache = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches?.default;
  if (edgeCache && env.PUBLIC_EDGE_CACHE !== '0') {
    return servePublicEdge(request, ctx, origin, {
      cache: edgeCache,
      now: Date.now,
      readGens: async names => {
        prepare(env);
        await redisReady;
        return readEdgeGensForHit(names);
      },
    });
  }
  return origin(stripFillMarker(request));
}

async function queue(batch: MessageBatchLike, env: CfBindings, ctx: Ctx): Promise<void> {
  // Write freeze (Ruling CF-JOBS-2): park every message of every consumer, drop none.
  setCfBindings(env);
  if (await parkIfFrozen(batch as unknown as ParkableBatch, env)) return;
  await withWorkerContext(env, ctx, () =>
    withReachLabel(`queue ${batch.queue}`, () =>
      // WhatsApp -> Store events (lib/wa) own their ack/retry; everything else is the cf/queues consumers.
      batch.queue === STORE_EVENTS_QUEUE || batch.queue === STORE_EVENTS_DLQ
        ? handleStoreEventsBatch(batch)
        : batch.queue === CI_EVENTS_QUEUE || batch.queue === CI_EVENTS_DLQ
          ? handleCiEventsBatch(batch, env)
          : handleQueueBatch(batch)
    )
  );
}

async function scheduled(
  controller: { cron: string; scheduledTime: number },
  env: CfBindings,
  ctx: Ctx
): Promise<void> {
  await withWorkerContext(env, ctx, async () => {
    await withReachLabel(`cron ${controller.cron}`, () =>
      runScheduled(controller.cron, controller.scheduledTime)
    );
  });
}

/**
 * Background jobs on Cloudflare Workflows (G5, lib/jobs): one instance per run. Every step body
 * runs inside `withWorkerContext`, so it has the bindings and its own leased database client
 * exactly like a request or a queue batch.
 */
class JobWorkflowBase extends WorkflowEntrypoint<CfBindings, JobParams> {
  async run(
    event: { payload: Readonly<JobParams>; instanceId: string },
    step: Parameters<typeof runJobWorkflow>[0]['step']
  ): Promise<void> {
    // Bindings for code that runs between steps (alerts, feature flags); step bodies get the full context.
    setCfBindings(this.env);
    await runJobWorkflow({
      params: event.payload as JobParams,
      instanceId: event.instanceId,
      step,
      withContext: fn => withWorkerContext(this.env, this.ctx, fn),
      NonRetryable: NonRetryableError,
    });
  }
}

const handler = { fetch: handle, queue, scheduled };

/**
 * Service Binding RPC for the shared identity service (accounts.ebda.app, Ruling ID-1/ID-2). Wired only in
 * ebda-accounts' wrangler config, so no other Worker (and no browser) can reach these. Each call runs inside
 * withWorkerContext exactly like a request, queue message or cron: a leased database connection and the role guard.
 */
export class StoreDirectory extends WorkerEntrypoint<CfBindings> {
  async storesForUser(userId: string): Promise<StoreClaim[]> {
    return withWorkerContext(this.env, this.ctx as Ctx, () => storesForUser(userId));
  }
  /** Identity v1.3: does this store still exist? (integrator clients of a deleted store are refused at once). */
  async storeExists(storeId: string): Promise<boolean> {
    return withWorkerContext(this.env, this.ctx as Ctx, () => storeLive(storeId));
  }
  /** Identity v1.3: may this store's integrator clients act now (not deleted, not suspended)? */
  async storeActive(storeId: string): Promise<boolean> {
    return withWorkerContext(this.env, this.ctx as Ctx, () => storeActive(storeId));
  }
}
/**
 * Service Binding RPC for Ebda Chat (identity contract v1.4). Wired ONLY in ebda-whatsapp's wrangler config. Each method is
 * authorised by the calling USER against live membership (never token claims) and fails closed.
 */
export class WhatsAppBridge extends WorkerEntrypoint<CfBindings> {
  /** The owner and active staff of a store, for seat assignment. Only the store's owner may ask. */
  async listStoreMembers(storeId: string, asUserId: string) {
    return withWorkerContext(this.env, this.ctx as Ctx, () => listStoreMembers(storeId, asUserId));
  }
  // Commerce RPC (contract section 5, Rulings WA-RPC-1..4). Each call runs in the Store's request context, gated on a resolved,
  // linked store, and answers with `{ ok, value | reason }` (expected failures are data; an unexpected error throws and the caller retries).
  private bridge<T>(fn: (b: ReturnType<typeof waBridge>) => Promise<T>) {
    return withWorkerContext(this.env, this.ctx as Ctx, () => fn(waBridge()));
  }
  getStoreProfile(storeId: string) {
    return this.bridge(b => b.getStoreProfile(storeId));
  }
  listCatalog(storeId: string, cursor: string | null, limit: number) {
    return this.bridge(b => b.listCatalog(storeId, cursor, limit));
  }
  getProducts(storeId: string, ids: string[]) {
    return this.bridge(b => b.getProducts(storeId, ids));
  }
  searchProducts(
    storeId: string,
    query: string,
    opts: { maxPriceMinor?: number; limit: number; searcher?: string }
  ) {
    return this.bridge(b => b.searchProducts(storeId, query, opts));
  }
  getStorePolicies(storeId: string) {
    return this.bridge(b => b.getStorePolicies(storeId));
  }
  getCustomerProfile(storeId: string, phoneE164: string) {
    return this.bridge(b => b.getCustomerProfile(storeId, phoneE164));
  }
  createCheckoutLink(storeId: string, req: unknown) {
    return this.bridge(b => b.createCheckoutLink(storeId, req));
  }
  createOrderFromChat(storeId: string, req: unknown) {
    return this.bridge(b => b.createOrderFromChat(storeId, req));
  }
  getPaymentLink(storeId: string, orderId: string, buyerKey?: string) {
    return this.bridge(b => b.getPaymentLink(storeId, orderId, buyerKey));
  }
  recordCodOutcome(storeId: string, req: unknown) {
    return this.bridge(b => b.recordCodOutcome(storeId, req));
  }
  attachPaymentProof(storeId: string, orderId: string, mediaUrl: string, buyerKey?: string) {
    return this.bridge(b => b.attachPaymentProof(storeId, orderId, mediaUrl, buyerKey));
  }
  getCustomerAddresses(storeId: string, buyerKey: string, phoneE164?: string) {
    return this.bridge(b => b.getCustomerAddresses(storeId, buyerKey, phoneE164));
  }
  saveCustomerAddress(storeId: string, buyerKey: string, address: unknown, phoneE164?: string) {
    return this.bridge(b => b.saveCustomerAddress(storeId, buyerKey, address, phoneE164));
  }
  getOrderStatus(storeId: string, orderNumber: string, buyerKey: string, phoneE164?: string) {
    return this.bridge(b => b.getOrderStatus(storeId, orderNumber, buyerKey, phoneE164));
  }
  getRecommendations(storeId: string, req: unknown) {
    return this.bridge(b => b.getRecommendations(storeId, req));
  }
  listCustomerOrders(storeId: string, buyerKey: string, limit: number, phoneE164?: string) {
    return this.bridge(b => b.listCustomerOrders(storeId, buyerKey, limit, phoneE164));
  }
  /** Owner assistant (Chat Smart Layer): best sellers for a period. Owner or active staff, authorised live by `asUserId`. */
  getTopProducts(storeId: string, asUserId: string, req: unknown) {
    return withWorkerContext(this.env, this.ctx as Ctx, () =>
      ownerTools().getTopProducts(storeId, asUserId, req)
    );
  }
  /** Owner assistant: order count, collected sales, refunds and average order value for a Cairo-day period (owner only, cached 60 s per store + period). */
  getOrdersSummary(storeId: string, asUserId: string, req: unknown) {
    return withWorkerContext(this.env, this.ctx as Ctx, () =>
      ownerTools().getOrdersSummary(storeId, asUserId, req)
    );
  }
  /** Owner assistant: create a percentage / fixed coupon. OWNER ONLY (live), replay-safe; Chat only calls it after the merchant's confirm press. */
  createCoupon(storeId: string, asUserId: string, req: unknown) {
    return withWorkerContext(this.env, this.ctx as Ctx, () =>
      ownerTools().createCoupon(storeId, asUserId, req)
    );
  }
  /** Revocation (v1.4): the live role of a user on a store, or null once removed. WhatsApp calls it on each staff request. */
  async memberRole(storeId: string, userId: string) {
    return withWorkerContext(this.env, this.ctx as Ctx, () => memberRole(storeId, userId));
  }
}
export class IdentityMailer extends WorkerEntrypoint<CfBindings> {
  async sendCode(input: CodeMail): Promise<void> {
    return withWorkerContext(this.env, this.ctx as Ctx, () => sendCodeMail(input));
  }
  async sendNotice(input: NoticeMail): Promise<void> {
    return withWorkerContext(this.env, this.ctx as Ctx, () => sendNoticeMail(input));
  }
}

// Errors, cron and queue failures go to Sentry (`@sentry/cloudflare`); with no SENTRY_DSN the
// client is disabled and this is a pass-through.
const sentryOptions = (env: CfBindings): Sentry.CloudflareOptions => ({
  dsn: typeof env.SENTRY_DSN === 'string' ? env.SENTRY_DSN : undefined,
  enabled: typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.length > 0,
  environment: typeof env.NODE_ENV === 'string' ? env.NODE_ENV : undefined,
  release:
    typeof env.BUILD_COMMIT_SHA === 'string' && env.BUILD_COMMIT_SHA
      ? env.BUILD_COMMIT_SHA
      : undefined,
  tracesSampleRate: 0.1,
  // Free-text query values (?search=, ?q=, ?email=, ?phone=) never leave in an event,
  // a transaction or a breadcrumb (search log review, fix-the-class).
  beforeSend: event => scrubSentryEvent(event),
  beforeSendTransaction: event => scrubSentryEvent(event),
  beforeBreadcrumb: breadcrumb => scrubSentryBreadcrumb(breadcrumb),
});

/**
 * The job Workflow, instrumented: a run that fails after its retries (and its steps' spans) reaches
 * Sentry like a request, queue batch or cron does. Inngest never reported to Sentry; this is the
 * parity-plus (the failure also fires `inngest/function.failed` -> alerts-failure-watch).
 */
export const JobWorkflow = Sentry.instrumentWorkflowWithSentry(
  sentryOptions,
  JobWorkflowBase as never
) as unknown as typeof JobWorkflowBase;

export default Sentry.withSentry(sentryOptions, handler as never);
