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
  __status: 'GET',
  // verify-store.mjs asks every DO for its table list (the DO must hold no table the cutover did not look at); without this
  // entry the Worker answered 404 and verify refused every store on the deployed API (found live 2026-10-31).
  __tables: 'GET',
} as const;

/** The only customer-auth operations the cutover channel may run (never login / refresh / reset). */
const AUTH_CUTOVER_OPS = new Set(['importRows', 'exportRowsPage', 'counts', 'markLive', 'isLive']);

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
  if (secret.length < 24) {
    // Unset (or too short to be a secret): the window is not open. Closed, and loud in the logs.
    logger.warn(
      { configured: secret.length > 0 },
      '[cutover] refused: CUTOVER_IMPORT_SECRET is unset or shorter than 24 characters'
    );
    return json({ ok: false, error: 'cutover disabled' }, 503);
  }
  if (!authorizeCutover(request, secret)) {
    logger.warn({ path: url.pathname }, '[cutover] refused: bad or missing bearer');
    return json({ ok: false, error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }

  const m = /^\/cutover\/stores\/([^/]+)\/(__[a-z]+)$/.exec(url.pathname);
  const action = m?.[2];
  if (!m || !action || !Object.hasOwn(ACTIONS, action))
    return json({ ok: false, error: 'not found' }, 404);
  const id = StoreId.safeParse(m[1]);
  if (!id.success) return json({ ok: false, error: 'invalid store id' }, 400);
  if (request.method !== ACTIONS[action as keyof typeof ACTIONS])
    return json({ ok: false, error: 'method not allowed' }, 405);

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
    const a = await authStub.authOp(id.data, body.op, encodeRpc(body.args ?? {}));
    return json(a, a.ok ? 200 : (a.status as number) || 500);
  }
  const stub = ns.get(ns.idFromName(id.data)) as unknown as {
    fetch(r: Request): Promise<Response>;
  };
  return stub.fetch(request);
}
