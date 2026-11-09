import { composeAlert, sendTelegram, type SendFetch } from './alert';
import {
  BRAND,
  BRAND_MARKETING_URL,
  SITE_NAV_JS,
  serviceLinesPublishedFromEnv,
} from '../../../packages/shared/src/brand/index';
import {
  pickStudioLang,
  renderStudioPage,
  HSTS_VALUE,
  STUDIO_PAGE_HEADERS,
} from '../../../packages/shared/src/studio-pages/index';
import { COMPONENTS, DEFAULT_FAIL_THRESHOLD, DEFAULT_RECOVER_THRESHOLD } from './config';
import { probeAll, type Fetcher } from './probe';
import { renderStatusPage, statusSearchDocs } from './render';
import { TYPEAHEAD_JS } from './typeahead-bundle';
import type { Impact, IncidentStatus, Thresholds } from './types';

export { StatusStore } from './store';

const SECURITY_HEADERS = {
  'content-security-policy':
    // script: only this Worker's own typeahead (/assets/typeahead.js); connect: its own search.json plus the help indexes
    `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' https://${BRAND.domains.help}; base-uri 'none'; form-action https://${BRAND.domains.help}; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': HSTS_VALUE,
};

const text = (body: string, type = 'text/plain', maxAge = 3600): Response =>
  new Response(body, {
    headers: {
      'content-type': `${type}; charset=utf-8`,
      'cache-control': `public, max-age=${maxAge}`,
      ...SECURITY_HEADERS,
    },
  });

/** RFC 9116. Expires is a year past the last review of this file: bump it in the same PR as any change. */
const SECURITY_EXPIRES = '2027-09-30T00:00:00.000Z';
export const securityTxt = (origin: string): string =>
  `Contact: mailto:security@${BRAND.domains.marketing}\nExpires: ${SECURITY_EXPIRES}\nPreferred-Languages: ar, en\nCanonical: ${origin}/.well-known/security.txt\nPolicy: ${BRAND_MARKETING_URL}/legal\n`;

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

/** Telegram on an incident opening or resolving (no-op without TELEGRAM_* secrets). Exported for tests. */
export async function alertOnOutcome(
  env: Cloudflare.Env,
  outcome: { opened: number[]; resolved: number[] },
  send?: SendFetch
): Promise<boolean> {
  if (!outcome.opened.length && !outcome.resolved.length) return false;
  const text = composeAlert(await store(env).snapshot(Date.now()), outcome);
  return text ? sendTelegram(env, text, send) : false;
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

    // Discovery files (site trust standard): this host's own robots, sitemap and security.txt
    if (path === '/robots.txt')
      return text(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`);
    // For AI assistants (help and docs have one): what this host is, and the machine-readable feed
    if (path === '/llms.txt')
      return text(
        `# ${BRAND.company.shortNameEn} Status\n\n> Live status of the ${BRAND.company.shortNameEn} products (${BRAND.product.nameEn} and the services around it), with recent incidents. Arabic at ${url.origin}/, English at ${url.origin}/en.\n\n- [Status page (English)](${url.origin}/en)\n- [Status page (Arabic)](${url.origin}/)\n- [JSON status feed](${url.origin}/api/status.json)\n`
      );
    if (path === '/sitemap.xml')
      return text(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${[
          '/',
          '/en',
        ]
          .map(
            p =>
              `<url><loc>${url.origin}${p}</loc><xhtml:link rel="alternate" hreflang="ar" href="${url.origin}/"/><xhtml:link rel="alternate" hreflang="en" href="${url.origin}/en"/><xhtml:link rel="alternate" hreflang="x-default" href="${url.origin}/"/></url>`
          )
          .join('\n')}\n</urlset>\n`,
        'application/xml'
      );
    if (path === '/.well-known/security.txt') return text(securityTxt(url.origin));

    // the shared header-nav behaviour (Esc, click-outside, one menu open, aria-expanded): a same-origin file, no inline script
    if (path === '/assets/site-nav.js')
      // an unhashed file: a short cache so a changed script reaches visitors within minutes, not an hour
      return text(SITE_NAV_JS, 'text/javascript', 300);

    if (path === '/healthz')
      return new Response('ok', { headers: { 'content-type': 'text/plain', ...SECURITY_HEADERS } });

    if (path === '/assets/typeahead.js')
      return new Response(TYPEAHEAD_JS, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          ...SECURITY_HEADERS,
        },
      });
    if (path === '/search.json') {
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ar';
      const snap = await store(env).snapshot(Date.now());
      return json(statusSearchDocs(snap, lang), 200, { 'cache-control': 'public, max-age=30' });
    }

    if (path === '/api/status.json') {
      const snap = await store(env).snapshot(Date.now());
      return json(snap, 200, {
        'cache-control': 'public, max-age=30',
        'access-control-allow-origin': '*',
      });
    }
    if (path === '/' || path === '/en') {
      const snap = await store(env).snapshot(Date.now());
      return new Response(
        renderStatusPage(
          snap,
          path === '/' ? 'ar' : 'en',
          url.origin,
          serviceLinesPublishedFromEnv({ EBDA_SERVICE_LINES: env.EBDA_SERVICE_LINES })
        ),
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // no-transform: Cloudflare then does not inject its Web Analytics beacon, which this page's CSP (rightly) blocks
            'cache-control': 'public, max-age=30, no-transform',
            ...SECURITY_HEADERS,
          },
        }
      );
    }
    // A person who mistyped a status URL gets the studio's calm 404 (search + a map); API clients keep the JSON.
    if (!path.startsWith('/api/') && (req.headers.get('accept') ?? '').includes('text/html')) {
      const lang = pickStudioLang(req.headers.get('accept-language'), url.searchParams.get('lang'));
      return new Response(
        req.method === 'HEAD' ? null : renderStudioPage({ lang, kind: 'not-found' }),
        {
          status: 404,
          headers: STUDIO_PAGE_HEADERS,
        }
      );
    }
    return json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runProbes(env)
        .then(outcome => alertOnOutcome(env, outcome))
        .catch(err => console.error('[status] probe round failed', err))
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
