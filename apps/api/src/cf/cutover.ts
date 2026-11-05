/**
 * The cutover admin surface on the API Worker (Rulings CUTOVER-2/3/4, docs/runbooks/cutover-cf.md):
 *
 *   /cutover/stores/<storeId>/{__import,__auditimport,__verify,__seal,__status,__unseal,__rebase,__diff,__analytics}
 *
 * The bearer check against CUTOVER_IMPORT_SECRET happens HERE, before the StoreDO sees the request, with
 * the constant-time compare that lives next to the handler (packages/cf-migrate, shared with the rehearsal
 * harness: one source, not a copy). Fail closed: no secret on the Worker = 503, never an open door.
 * Every path under /cutover/ is answered here and never reaches Express.
 */
import { z } from 'zod/v3';
import { authorizeCutover } from '../../../../packages/cf-migrate/src/store-admin.mjs';
import logger from '../lib/logger';
import type { CfBindings } from './bindings';

export const CUTOVER_PREFIX = '/cutover/';

const ACTIONS = {
  __import: 'POST',
  __verify: 'POST',
  __auditimport: 'POST',
  __seal: 'POST',
  __unseal: 'POST',
  __rebase: 'POST',
  __diff: 'POST',
  // Ruling NZ-AN-1: the per-store analytics copy (scripts/cf/copy-analytics-to-do.mjs): status / import batch / finish
  __analytics: 'POST',
  // N-9: the customer-auth import/verify channel (scripts/cf/cutover-customer-auth.mjs). Body {op, args}; only the ops below.
  __auth: 'POST',
  // Ruling NZ-BACKUP-1: read-only page of a table for the nightly off-Cloudflare backup (scripts/ops/backup-cf.mjs).
  __export: 'POST',
  __status: 'GET',
  // verify-store.mjs asks every DO for its table list (the DO must hold no table the cutover did not look at); without this
  // entry the Worker answered 404 and verify refused every store on the deployed API (found live 2026-10-31).
  __tables: 'GET',
  // Ruling NZ-BACKUP-1: read-only foreign-key map, so a restore replays parent tables first.
  __fks: 'GET',
} as const;

/** The only customer-auth operations the cutover channel may run (never login / refresh / reset). */
const AUTH_CUTOVER_OPS = new Set(['importRows', 'exportRowsPage', 'counts', 'markLive', 'isLive']);

/** The only actions BACKUP_EXPORT_SECRET opens (Ruling NZ-BACKUP-1): reads, never a write. */
export const BACKUP_READ_ACTIONS = new Set(['__export', '__tables', '__status', '__fks']);

/** Store ids are UUIDs (lowercase); the DO instance name IS the id (lib/store-backend.ts storeDo()). */
const StoreId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const json = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Answers a /cutover/ request, or null when the path is not ours. */
export async function routeCutover(request: Request, env: CfBindings): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CUTOVER_PREFIX)) return null;

  const secret = typeof env.CUTOVER_IMPORT_SECRET === 'string' ? env.CUTOVER_IMPORT_SECRET : '';
  // Ruling NZ-BACKUP-1: a SECOND secret that opens only the read-only actions, so the nightly backup never needs the cutover
  // secret (which is deleted when the cutover window closes). It cannot reach __import / __seal / __unseal / ... .
  const backupSecret = typeof env.BACKUP_EXPORT_SECRET === 'string' ? env.BACKUP_EXPORT_SECRET : '';
  if (secret.length < 24 && backupSecret.length < 24) {
    // Unset (or too short to be a secret): the window is not open. Closed, and loud in the logs.
    logger.warn(
      { configured: secret.length > 0 || backupSecret.length > 0 },
      '[cutover] refused: CUTOVER_IMPORT_SECRET and BACKUP_EXPORT_SECRET are unset or shorter than 24 characters'
    );
    return json({ ok: false, error: 'cutover disabled' }, 503);
  }
  const m = /^\/cutover\/stores\/([^/]+)\/(__[a-z]+)$/.exec(url.pathname);
  const action = m?.[2];
  const fullAccess = authorizeCutover(request, secret);
  const readOnlyAccess =
    !fullAccess && BACKUP_READ_ACTIONS.has(action ?? '') && authorizeCutover(request, backupSecret);
  if (!fullAccess && !readOnlyAccess) {
    logger.warn({ path: url.pathname }, '[cutover] refused: bad or missing bearer');
    return json({ ok: false, error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }

  if (!m || !action || !Object.hasOwn(ACTIONS, action))
    return json({ ok: false, error: 'not found' }, 404);
  const id = StoreId.safeParse(m[1]);
  if (!id.success) return json({ ok: false, error: 'invalid store id' }, 400);
  if (request.method !== ACTIONS[action as keyof typeof ACTIONS])
    return json({ ok: false, error: 'method not allowed' }, 405);

  // Ruling NZ-AN-1: the analytics copy may WIPE a DO's analytics tables to restart cleanly, but only while the D1 marker does not
  // exist (after it the DO holds native rows that exist nowhere else). The DO cannot see D1, so the check lives here.
  if (action === '__analytics') {
    let op: unknown;
    try {
      op = ((await request.clone().json()) as { op?: unknown }).op;
    } catch {
      return json({ ok: false, error: 'bad json' }, 400);
    }
    if (op === 'analyticsImportReset') {
      const d1 = (
        env as unknown as {
          PLATFORM_DB?: {
            prepare(sql: string): { bind(...v: unknown[]): { first(): Promise<unknown> } };
          };
        }
      ).PLATFORM_DB;
      if (!d1) return json({ ok: false, error: 'PLATFORM_DB is not bound' }, 503);
      let marked: unknown;
      try {
        marked = await d1
          .prepare('SELECT 1 AS n FROM system_settings WHERE key = ?1')
          .bind('platform_cutover.analytics')
          .first();
      } catch {
        return json({ ok: false, error: 'marker unreadable' }, 503);
      }
      if (marked)
        return json(
          { ok: false, code: 'ANALYTICS_MARKER_SET', message: 'reset refused after the marker' },
          409
        );
    }
  }

  const ns = env.STORE_DO;
  if (!ns) return json({ ok: false, error: 'STORE_DO is not bound' }, 503);
  if (action === '__auth') {
    const body = (await request.json().catch(() => null)) as {
      op?: unknown;
      args?: unknown;
    } | null;
    if (!body || typeof body.op !== 'string' || !AUTH_CUTOVER_OPS.has(body.op))
      return json({ ok: false, error: 'op not allowed' }, 400);
    const { encodeRpc } = await import('@ebda-src/repo');
    const authStub = ns.get(ns.idFromName(id.data)) as unknown as {
      authOp(
        storeId: string,
        op: string,
        argsJson: string
      ): Promise<{ ok: boolean; [k: string]: unknown }>;
    };
    // Once the store's marker exists (store-create's `markCustomerAuthOnDo`, `--global`, a flip whose run did not finish) the DO is the
    // source of truth: an import could overwrite what it accepted since. Refused 423, whatever the DO's own live flag says.
    if (
      body.op === 'importRows' &&
      (await (await import('../lib/customer-auth.js')).customerAuthOnDo(id.data))
    )
      return json(
        {
          ok: false,
          code: 'CUSTOMER_AUTH_LIVE',
          error: 'customer auth is served by the StoreDO: imports are closed',
        },
        423
      );
    const a = await authStub.authOp(id.data, body.op, encodeRpc(body.args ?? {}));
    return json(a, a.ok ? 200 : (a.status as number) || 500);
  }
  const stub = ns.get(ns.idFromName(id.data)) as unknown as {
    fetch(r: Request): Promise<Response>;
  };
  return stub.fetch(request);
}
