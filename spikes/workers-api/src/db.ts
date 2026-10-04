import { PrismaPg } from '@prisma/adapter-pg';
// Explicit workerd entry (query-compiler + wasm, no native engine).
import { PrismaClient, type Prisma } from './generated/prisma/wasm.js';
import { parseHost, type HostKey } from './host';

export type Tx = Prisma.TransactionClient;
export interface DbEnv {
  HYPERDRIVE: { connectionString: string };
  BASE_DOMAIN: string;
}

export const GUC_STORE = 'app.current_store_id'; // same names as FWB
export const GUC_USER = 'app.current_user_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prisma client PER REQUEST (never module-global).
 * workerd forbids reusing I/O objects (sockets, streams) created in one request's
 * context from another request ("Cannot perform I/O on behalf of a different
 * request"). pg Pool/Client hold sockets, so a global client breaks as soon as a
 * second request touches a socket opened by the first. Hyperdrive makes
 * per-request connections cheap (the pooler holds the real server connections),
 * so we create client+pool(max 1) per request and $disconnect after the response.
 */
export function makePrisma(env: DbEnv): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  return new PrismaClient({ adapter });
}

/** Transaction-LOCAL GUCs. `true` = is_local: reverts at COMMIT/ROLLBACK, so a pooler
 *  that hands this server connection to another tenant next can never see it. */
export async function setTenantGucs(tx: Tx, g: { storeId?: string; userId?: string }): Promise<void> {
  if (g.storeId !== undefined) {
    if (!UUID_RE.test(g.storeId)) throw new Error('Invalid store ID format');
    await tx.$queryRaw`SELECT set_config('app.current_store_id', ${g.storeId}, true)`;
  }
  if (g.userId !== undefined) {
    if (!UUID_RE.test(g.userId)) throw new Error('Invalid user ID format');
    await tx.$queryRaw`SELECT set_config('app.current_user_id', ${g.userId}, true)`;
  }
}

export interface Reply { status: number; body: unknown; headers?: Record<string, string> }
export interface Scope { storeId: string; userId?: string; defer(fn: () => Promise<void>): void; backendPid?: number }

export interface RequestResult { reply: Reply; deferred: Array<() => Promise<void>>; txMs: number; pid?: number }

/**
 * ONE interactive transaction per request:
 *   BEGIN; resolve host->store; set_config(..., true) x2; handler queries; COMMIT
 * The Reply is only turned into a Response by the caller AFTER this resolves
 * (commit-before-respond). Anything that talks to the outside world must be
 * queued with scope.defer() and runs after COMMIT (ctx.waitUntil), never inside.
 */
export async function runRequest(
  env: DbEnv,
  host: string | null,
  userId: string | undefined,
  handler: (tx: Tx, scope: Scope) => Promise<Reply>,
  opts: { wantPid?: boolean } = {}
): Promise<RequestResult> {
  const key: HostKey | null = parseHost(host, env.BASE_DOMAIN);
  if (!key) return { reply: { status: 404, body: { error: 'unknown_host' } }, deferred: [], txMs: 0 };
  const prisma = makePrisma(env);
  const deferred: Array<() => Promise<void>> = [];
  const t0 = performance.now();
  try {
    const reply = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string | null }[]>`SELECT resolve_store_id(${key.slug}, ${key.domain}) AS id`;
        const storeId = rows[0]?.id;
        if (!storeId) return { status: 404, body: { error: 'unknown_host' } } as Reply;
        await setTenantGucs(tx, { storeId, userId });
        const scope: Scope = { storeId, userId, defer: (fn) => void deferred.push(fn) };
        if (opts.wantPid) {
          const p = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          scope.backendPid = p[0]?.pid;
        }
        const r = await handler(tx, scope);
        if (scope.backendPid) r.headers = { ...r.headers, 'x-ebda-backend-pid': String(scope.backendPid) };
        return r;
      },
      { maxWait: 5000, timeout: 10000 } // FWB uses maxWait 10s / timeout 30s; tighter here, edge requests are short
    );
    // A handler that returns a 5xx should roll back; we throw inside handlers for that, so commit happened here.
    return { reply, deferred, txMs: performance.now() - t0 };
  } finally {
    // Release the pool after the response path; failure to disconnect must not fail the request.
    void prisma.$disconnect().catch(() => {});
  }
}
