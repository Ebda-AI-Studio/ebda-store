import { COMPONENTS, DEFAULT_FAIL_THRESHOLD, DEFAULT_RECOVER_THRESHOLD } from './config';
import { probeAll, type Fetcher } from './probe';
import { renderStatusPage } from './render';
import type { Impact, IncidentStatus, Thresholds } from './types';

export { StatusStore } from './store';

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const intEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : d;
};

export const thresholdsFrom = (env: Cloudflare.Env): Thresholds => ({
  fail: intEnv(env.FAIL_THRESHOLD, DEFAULT_FAIL_THRESHOLD),
  recover: intEnv(env.RECOVER_THRESHOLD, DEFAULT_RECOVER_THRESHOLD),
});

const store = (env: Cloudflare.Env) => env.STATUS_STORE.get(env.STATUS_STORE.idFromName('global'));

/** One probe round: probe every component, then record. Exported so tests drive it directly. */
export async function runProbes(
  env: Cloudflare.Env,
  opts: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {}
) {
  const results = await probeAll(COMPONENTS, opts.fetcher, opts.timeoutMs);
  return store(env).record(results, opts.now ?? Date.now(), thresholdsFrom(env));
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time secret check. An unset secret fails closed (nobody can post). */
async function authorized(req: Request, env: Cloudflare.Env): Promise<boolean> {
  const secret = env.STATUS_SECRET;
  const given = req.headers.get('x-status-secret');
  if (!secret || !given) return false;
  const [a, b] = await Promise.all([sha256(secret), sha256(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });

const IMPACTS: readonly Impact[] = ['degraded', 'outage'];
const STATUSES: readonly IncidentStatus[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
];

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null;
const optStr = (v: unknown, max: number): string | null | undefined =>
  v === undefined || v === null ? null : (str(v, max) ?? undefined);

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handleIncidentPost(
  req: Request,
  env: Cloudflare.Env,
  path: string
): Promise<Response> {
  if (!(await authorized(req, env)))
    return json({ success: false, error: { code: 'UNAUTHORIZED' } }, 401);
  const body = await readBody(req);
  if (!body) return json({ success: false, error: { code: 'INVALID_JSON' } }, 400);
  const now = Date.now();
  const bad = (field: string) =>
    json({ success: false, error: { code: 'VALIDATION_ERROR', field } }, 400);

  const upd = /^\/api\/incidents\/(\d+)\/updates$/.exec(path);
  if (upd) {
    const text = str(body.body, 2000);
    const textAr = optStr(body.bodyAr, 2000);
    const status = body.status as IncidentStatus;
    if (!text) return bad('body');
    if (textAr === undefined) return bad('bodyAr');
    if (!STATUSES.includes(status)) return bad('status');
    const ok = await store(env).addManualUpdate(Number(upd[1]), status, text, textAr, now);
    return ok
      ? json({ success: true })
      : json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
  }

  const title = str(body.title, 120);
  const titleAr = optStr(body.titleAr, 120);
  const text = str(body.body, 2000);
  const textAr = optStr(body.bodyAr, 2000);
  const impact = body.impact as Impact;
  const component = body.component ?? null;
  if (!title) return bad('title');
  if (titleAr === undefined) return bad('titleAr');
  if (!text) return bad('body');
  if (textAr === undefined) return bad('bodyAr');
  if (!IMPACTS.includes(impact)) return bad('impact');
  if (component !== null && !COMPONENTS.some(c => c.id === component)) return bad('component');
  const id = await store(env).createManualIncident({
    component: component as string | null,
    title,
    titleAr,
    impact,
    body: text,
    bodyAr: textAr,
    now,
  });
  return json({ success: true, data: { id } }, 201);
}

export default {
  async fetch(req: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/(.)\/+$/, '$1');

    if (
      req.method === 'POST' &&
      (path === '/api/incidents' || /^\/api\/incidents\/\d+\/updates$/.test(path))
    ) {
      return handleIncidentPost(req, env, path);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json({ success: false, error: { code: 'METHOD_NOT_ALLOWED' } }, 405, {
        allow: 'GET, HEAD, POST',
      });
    }

    if (path === '/healthz')
      return new Response('ok', { headers: { 'content-type': 'text/plain', ...SECURITY_HEADERS } });

    if (path === '/api/status.json') {
      const snap = await store(env).snapshot(Date.now());
      return json(snap, 200, {
        'cache-control': 'public, max-age=30',
        'access-control-allow-origin': '*',
      });
    }
    if (path === '/' || path === '/en') {
      const snap = await store(env).snapshot(Date.now());
      return new Response(renderStatusPage(snap, path === '/' ? 'ar' : 'en', url.origin), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=30',
          ...SECURITY_HEADERS,
        },
      });
    }
    return json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(runProbes(env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
