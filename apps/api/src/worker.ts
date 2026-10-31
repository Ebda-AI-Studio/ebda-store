/**
 * The Ebda API as a Cloudflare Worker (R-EBDA-001, SP4 Stage 1).
 *
 * Express (app.ts, shared with the Node shell in index.ts) runs through
 * `handleAsNodeRequest` (`cloudflare:node`, `nodejs_compat`). Everything that is
 * Worker-specific lives in this file and src/cf/:
 *
 *   - a POOL of Prisma clients per isolate, each leased to one request at a time and reused (the
 *     engine, ~3.3 MB, is built once per client, not per request), over a leased driver adapter.
 *     The pg connection (pool of one, over Hyperdrive) is per request and opened lazily: workerd
 *     forbids reusing an I/O object (a socket) from another request (experiment B6/B9). One client
 *     shared by concurrent requests hangs, see packages/database/src/client-pool.ts. The
 *     connection is closed, and the client returned, through `ctx.waitUntil`, after the post-commit
 *     deferred work (`deferAfterTenantCommit`) has drained on it.
 *   - the client's real IP: Cloudflare's `cf-connecting-ip` overwrites X-Forwarded-For,
 *     so `trust proxy` = 1 yields the connecting address and a spoofed header is dropped.
 *   - Queue, Cron and Durable Object entry points (consumers, scheduled, AuthState,
 *     StoreRealtime), and the WebSocket upgrade for realtime (`/socket.io/`).
 */
import { handleAsNodeRequest } from 'cloudflare:node';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createServer } from 'node:http';
import app from './app';
import { ClientPoolTimeout, createIsolateDb, type IsolateDb } from '@ebda/database';
import { awaitDeferredWork } from './lib/after-tenant-commit';
import { redis } from './services/redis.service';
import { SentryService } from './services/sentry.service';
import logger from './lib/logger';
import { runWithWaitUntil, setCfBindings, type CfBindings } from './cf/bindings';
import { devProbe, devStats, noteLease, noteLeaseClosing } from './cf/dev-stats';
import { handleQueueBatch, type MessageBatchLike } from './cf/queues';
import { parkIfFrozen, type ParkableBatch } from './cf/queue-freeze';
import { handleStoreEventsBatch } from './lib/wa/store-events-queue';
import { STORE_EVENTS_DLQ, STORE_EVENTS_QUEUE } from './lib/wa/config';
import { runScheduled } from './cf/cron';
import { routeCutover } from './cf/cutover';
import { runJobWorkflow } from './lib/jobs/run-workflow';
import type { JobParams } from './lib/jobs/start';
import {
  createDatabaseRoleGuard,
  queryDatabaseRole,
  type RoleQueryable,
} from './cf/database-role-guard';
import { servePublicEdge, stripFillMarker, type CacheLike } from './cf/public-edge-cache';
import { readEdgeGens } from './lib/edge-gens';
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

let isolateDb: IsolateDb | undefined;

const validateDatabaseRole = createDatabaseRoleGuard();
let redisReady: Promise<void> | undefined;

/**
 * The BYPASSRLS guard that index.ts runs at listen() on Node (finding #5): if the connection role
 * bypasses RLS, tenant isolation is off. LAZY (Ruling ROLE-GUARD-LAZY-1): it runs on a request's own
 * connection the first time that request actually opens Postgres (`ConnectionScope` onConnect), so a
 * request served by D1 or a Durable Object never touches Postgres, and one that does still fails
 * closed. Cache only success (a Worker has no boot moment).
 */
async function checkRoleOnConnect(adapter: RoleQueryable): Promise<void> {
  await validateDatabaseRole(async () => {
    const rows = await queryDatabaseRole(adapter);
    const bypass = rows[0]?.bypass === true;
    logger.info(
      { currentUser: rows[0]?.currentUser, rolbypassrls: bypass },
      `[SECURITY] DB role check: current_user=${rows[0]?.currentUser ?? 'unknown'} rolbypassrls=${bypass}`
    );
    return rows;
  });
}

/** Drop a client-supplied `x-ebda-backend` (the retired Phase 0 opt-in) before anything reads the request. */
export function stripBackendHeader(request: Request): Request {
  if (!request.headers.has('x-ebda-backend')) return request;
  const headers = new Headers(request.headers);
  headers.delete('x-ebda-backend');
  return new Request(request, { headers });
}

/** Overwrite X-Forwarded-For with the address Cloudflare saw, so `trust proxy` cannot be spoofed. */
function withTrustedClientIp(request: Request): Request {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return request;
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-for', ip);
  return new Request(request, { headers });
}

let embeddingConfigChecked = false;
let whatsAppConfigChecked = false;

function prepare(env: CfBindings): void {
  setCfBindings(env);
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
  // No sockets to open: this only flips redis.service to "available" over AuthState + KV.
  redisReady ??= redis.connect();
  const deployment = env.CF_VERSION_METADATA?.id;
  if (deployment && !process.env.CF_DEPLOYMENT_ID) process.env.CF_DEPLOYMENT_ID = deployment;
}

/**
 * Run `fn` with everything a Worker invocation needs: the bindings recorded, `waitUntil` on
 * AsyncLocalStorage, and a leased Prisma client with this request's own database connection
 * (returned, and the connection closed, after the deferred work drains). Used by fetch, queue and
 * scheduled alike: a queue consumer or a cron touches the database exactly as a request does.
 */
async function withWorkerContext<T>(
  env: CfBindings,
  ctx: Ctx,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  prepare(env);
  isolateDb ??= createIsolateDb({
    connectionString: env.HYPERDRIVE.connectionString,
    onConnect: checkRoleOnConnect,
    // Engines (~3.3 MB each) per isolate; a request waits for one when all are leased. Override
    // with the DB_CLIENT_CONCURRENCY / DB_CLIENT_WAIT_MS vars.
    max: Number(env.DB_CLIENT_CONCURRENCY) > 0 ? Number(env.DB_CLIENT_CONCURRENCY) : undefined,
    maxWaitMs: Number(env.DB_CLIENT_WAIT_MS) > 0 ? Number(env.DB_CLIENT_WAIT_MS) : undefined,
    maxQueue: Number(env.DB_CLIENT_QUEUE) > 0 ? Number(env.DB_CLIENT_QUEUE) : undefined,
    // Prisma drops the stack of an adapter error; a RangeError ("Invalid array buffer length",
    // incident 2026-10-22) is captured here with its own stack and the pool state.
    onClientRangeError: (err, ctx) =>
      Sentry.captureException(err, {
        tags: { site: 'prisma-request', op: ctx.operation, model: ctx.model ?? 'raw' },
        extra: { ...ctx },
      }),
    onAdapterError: (err, op, stats) =>
      Sentry.captureException(err, {
        tags: { site: 'prisma-adapter', op },
        extra: { pool: stats },
      }),
    // The API opens a second transaction while the request's tenant transaction is open.
    connectionsPerRequest:
      Number(env.DB_REQUEST_CONNECTIONS) > 0 ? Number(env.DB_REQUEST_CONNECTIONS) : undefined,
    log: ['error', 'warn'],
    // The request's connection is ended after every request; workerd reports that as a
    // cancelled stream on the idle client. Not an error.
    onPoolError: err => logger.debug({ err: err.message }, '[database] idle pool client error'),
  });
  const db = isolateDb;
  let lease: ReturnType<IsolateDb['currentLease']>;
  // Work the request handed to `cfWaitUntil` (a verification email, a webhook fan-out, ...) runs on
  // THIS request's database lease. The lease is returned to the pool only after it has settled:
  // a Prisma call after that would land on the next request's connection.
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
    db.run(
      async () => {
        lease = db.currentLease();
        noteLease(lease);
        return fn();
      },
      {
        waitUntil: p => ctx.waitUntil(p),
        signal,
        // Post-commit work runs on this request's connection and must finish before it closes.
        beforeDisconnect: () =>
          awaitDeferredWork(DRAIN_BUDGET_MS)
            .then(drainFloating)
            .finally(() => {
              // The lease is released right after this; its `opened` count is final.
              noteLeaseClosing(lease);
            }),
      }
    )
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
  request: Request,
  env: CfBindings,
  path: string
): Promise<Response | null> {
  if (!env.RATE_LIMITER || path === '/health') return null;
  const ip = request.headers.get('cf-connecting-ip');
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
  const request = stripBackendHeader(incoming);
  const path = new URL(request.url).pathname;
  if (path === '/__dev/stats') {
    const res = devStats(env, isolateDb);
    if (res) return res;
  }
  if (path === '/__dev/probe' && env.DEV_STATS === '1') {
    const url = new URL(request.url);
    const res = await withWorkerContext(env, ctx, () => devProbe(env, isolateDb!, url));
    if (res) return res;
  }
  // Cutover admin surface (docs/runbooks/cutover-cf.md): bearer-checked before the StoreDO sees it.
  const cutover = await routeCutover(request, env);
  if (cutover) return cutover;
  const flooded = await floodGuard(request, env, path);
  if (flooded) return flooded;
  if (path === '/socket.io/' || path === '/socket.io') {
    prepare(env);
    // The upgrade is authenticated in the DO via the API; the Express app is not involved.
    return routeRealtime(request, env);
  }
  const origin = async (req: Request): Promise<Response> => {
    const forwarded = withTrustedClientIp(req);
    try {
      return await withWorkerContext(
        env,
        ctx,
        () => handleAsNodeRequest(PORT, forwarded, env, ctx),
        req.signal
      );
    } catch (err) {
      if (err instanceof ClientPoolTimeout) {
        if (err.reason === 'aborted') return new Response(null, { status: 499 }); // client already gone
        logger.warn({ pool: isolateDb?.stats(), reason: err.message }, '[database] request shed');
        // Shed load instead of letting the isolate hit its memory limit.
        return Response.json(
          { success: false, error: { code: 'OVERLOADED', message: 'Server busy, please retry.' } },
          { status: 503, headers: { 'retry-after': '1' } }
        );
      }
      throw err;
    }
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
        return readEdgeGens(names);
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
    // WhatsApp -> Store events (lib/wa) own their ack/retry; everything else is the cf/queues consumers.
    batch.queue === STORE_EVENTS_QUEUE || batch.queue === STORE_EVENTS_DLQ
      ? handleStoreEventsBatch(batch)
      : batch.queue === CI_EVENTS_QUEUE || batch.queue === CI_EVENTS_DLQ
        ? handleCiEventsBatch(batch, env)
        : handleQueueBatch(batch)
  );
}

async function scheduled(
  controller: { cron: string; scheduledTime: number },
  env: CfBindings,
  ctx: Ctx
): Promise<void> {
  await withWorkerContext(env, ctx, async () => {
    await runScheduled(controller.cron, controller.scheduledTime);
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
 * Service Binding RPC for Ebda WhatsApp (identity contract v1.4). Wired ONLY in ebda-whatsapp's wrangler config. Each method is
 * authorised by the calling USER against live membership (never token claims) and fails closed.
 */
export class WhatsAppBridge extends WorkerEntrypoint<CfBindings> {
  /** The owner and active staff of a store, for seat assignment. Only the store's owner may ask. */
  async listStoreMembers(storeId: string, asUserId: string) {
    return withWorkerContext(this.env, this.ctx as Ctx, () => listStoreMembers(storeId, asUserId));
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
