// Dev-only isolate diagnostics for the Stage 2 memory / soak measurements.
//
// `GET /__dev/stats` and `GET /__dev/probe` answer ONLY when the Worker is started with
// `DEV_STATS=1` (a var in `.dev.vars` or the workerd test config, never in wrangler.jsonc), so a
// deployed Worker has no such routes. Stats report what the leased-client design promises: clients
// built never exceed the pool maximum, leases still held when idle are 0 (no leaked connection or
// client), and requests that never queried opened no connection.
import type { ClientLease, IsolateDb } from '@force/database';
import type { CfBindings } from './bindings';

let leasesSeen = 0;
let leasesWithConnection = 0;
const booted = Date.now();

/** Called once per lease. Counters only; the lease itself is not retained. */
export function noteLease(lease: ClientLease | undefined): void {
  if (lease) leasesSeen++;
}

/** Called when a request's connection is about to close: `opened` is final. */
export function noteLeaseClosing(lease: ClientLease | undefined): void {
  if (lease && lease.scope.opened > 0) leasesWithConnection++;
}

const clientIds = new WeakMap<object, string>();
const clientId = (client: object): string => {
  let id = clientIds.get(client);
  if (!id) {
    id = crypto.randomUUID();
    clientIds.set(client, id);
  }
  return id;
};

/**
 * `GET /__dev/probe?ms=300`: runs ONE transaction on this request's connection, holds it for
 * `ms`, and reports which pooled client and which connection scope served it plus the Postgres
 * backend pid (workers-test/db-scope.test.ts).
 */
export async function devProbe(env: CfBindings, db: IsolateDb, url: URL): Promise<Response | null> {
  if (env.DEV_STATS !== '1') return null;
  const ms = Math.min(2000, Math.max(0, Number(url.searchParams.get('ms')) || 300));
  const lease = db.currentLease();
  if (!lease) return Response.json({ error: 'no lease' }, { status: 500 });
  const nested = url.searchParams.get('nested') === '1';
  const rows = await lease.client.$transaction(async tx => {
    const first = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await tx.$queryRaw`SELECT pg_sleep(${ms / 1000})`;
    const second = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    // The API opens a SECOND transaction while the request's is open (withMoneyTx inside
    // runInTenantContext). With one connection per request this waited for pg's connect timeout.
    const inner = nested
      ? await lease.client.$transaction(async tx2 => {
          const r = await tx2.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          return r[0]?.pid;
        })
      : undefined;
    return { first: first[0]?.pid, second: second[0]?.pid, nestedPid: inner };
  });
  return Response.json({ clientId: clientId(lease.client), scopeId: lease.scope.id, ...rows });
}

export function devStats(env: CfBindings, db: IsolateDb | undefined): Response | null {
  if (env.DEV_STATS !== '1') return null;
  return Response.json({
    uptimeMs: Date.now() - booted,
    pool: db?.stats() ?? null,
    leasesSeen,
    leasesWithConnection,
  });
}
