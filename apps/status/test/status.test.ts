import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { alertOnOutcome, runProbes, thresholdsFrom } from '../src/index';
import { SITE_NAV_JS } from '../../../packages/shared/src/brand/index';
import { COMPONENTS } from '../src/config';
import { probe, probeErrorAr, type Fetcher } from '../src/probe';
import type { ProbeResult, Snapshot } from '../src/types';

const MIN = 60_000;
const DAY = 86_400_000;
const T = { fail: 3, recover: 2 };
const stub = () => env.STATUS_STORE.get(env.STATUS_STORE.idFromName('global'));
const res = (
  id: string,
  ok: boolean,
  error: string | null = ok ? null : 'status 503'
): ProbeResult => ({
  id,
  ok,
  status: ok ? 200 : 503,
  latencyMs: 12,
  error,
});

/** Wipe all rows (Durable Object storage persists across tests in a file). */
beforeEach(async () => {
  await runInDurableObject(stub(), (_i, state) => {
    for (const t of ['component_state', 'daily', 'incidents', 'incident_updates']) {
      state.storage.sql.exec(`DELETE FROM ${t}`);
    }
  });
});

const body = '<html>ebda <main data-zone="hero"></main> {"status":"ok"}</html>';
const healthy: Fetcher = async () => new Response(body, { status: 200 });
/** Everything healthy except the API, which answers 503. */
const apiDown: Fetcher = async url =>
  url.includes('api.ebda.app') ? new Response('boom', { status: 503 }) : new Response(body);
const get = (path: string) => worker.fetch(new Request(`https://status.ebda.app${path}`), env);
/** Boolean assertion so a failure does not dump the whole page into the log. */
const has = (html: string, needle: string) => html.includes(needle);
const snapshot = async (): Promise<Snapshot> =>
  (await (await get('/api/status.json')).json()) as Snapshot;

describe('content audit C6/C7', () => {
  it('monitors Ebda Chat (wa.ebda.app/health) under its own product group', () => {
    const chat = COMPONENTS.find(c => c.id === 'chat');
    expect(chat?.url).toBe('https://wa.ebda.app/health');
    expect(chat?.product).toBe('chat');
  });

  it('words every probe error in Egyptian Arabic', () => {
    expect(probeErrorAr('timeout after 8000ms')).toBe('مفيش رد خلال 8 ثواني');
    expect(probeErrorAr('status 503, expected 200')).toBe('رجّع كود 503 بدل 200');
    expect(probeErrorAr('body did not match')).toBe('الصفحة رجعت من غير المحتوى المتوقع');
    expect(probeErrorAr('fetch failed (TypeError)')).toBe('الاتصال فشل');
    expect(probeErrorAr(null)).toBe('خطأ مش معروف');
  });
});

describe('probe', () => {
  const api = COMPONENTS.find(c => c.id === 'api')!;

  it('passes on expected status and body', async () => {
    expect((await probe(api, healthy)).ok).toBe(true);
  });

  it('fails on a wrong status', async () => {
    const r = await probe(api, async () => new Response('x', { status: 500 }));
    expect(r).toMatchObject({ ok: false, status: 500 });
  });

  it('fails when the body does not match', async () => {
    const r = await probe(api, async () => new Response('<html>nothing</html>'));
    expect(r).toMatchObject({ ok: false, error: 'body did not match' });
  });

  it('counts a timeout as a failure, even when fetch ignores the abort signal', async () => {
    const hang: Fetcher = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const r = await probe(api, hang, 40);
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/timeout after 40ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('counts a network error as a failure', async () => {
    const r = await probe(api, async () => {
      throw new TypeError('network');
    });
    expect(r).toMatchObject({ ok: false, status: null, error: 'fetch failed (TypeError)' });
  });
});

describe('incident lifecycle (fail threshold 3, recover threshold 2)', () => {
  it('opens exactly one incident on the 3rd consecutive failure, not the 2nd', async () => {
    const now = Date.now();
    const s = stub();
    expect(await s.record([res('api', false)], now, T)).toEqual({ opened: [], resolved: [] });
    expect(await s.record([res('api', false)], now + MIN, T)).toEqual({ opened: [], resolved: [] });
    expect((await s.snapshot(now + 2 * MIN)).active).toHaveLength(0);

    const third = await s.record([res('api', false)], now + 2 * MIN, T);
    expect(third.opened).toHaveLength(1);
    // Further failures do not open duplicates.
    expect((await s.record([res('api', false)], now + 3 * MIN, T)).opened).toHaveLength(0);

    const snap = await s.snapshot(now + 4 * MIN);
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0]).toMatchObject({ component: 'api', source: 'auto', impact: 'outage' });
    expect(snap.components.find(c => c.id === 'api')!.status).toBe('outage');
    expect(snap.overall).toBe('outage');
  });

  it('a success in between resets the failure streak', async () => {
    const now = Date.now();
    const s = stub();
    for (const [i, ok] of [false, false, true, false, false].entries()) {
      await s.record([res('api', ok)], now + i * MIN, T);
    }
    expect((await s.snapshot(now + 6 * MIN)).active).toHaveLength(0);
  });

  it('resolves after 2 consecutive successes, not after 1', async () => {
    const now = Date.now();
    const s = stub();
    for (let i = 0; i < 3; i++) await s.record([res('api', false)], now + i * MIN, T);
    expect((await s.record([res('api', true)], now + 3 * MIN, T)).resolved).toHaveLength(0);
    expect((await s.snapshot(now + 3 * MIN)).active).toHaveLength(1);
    // A failure in the middle restarts the recovery streak.
    await s.record([res('api', false)], now + 4 * MIN, T);
    await s.record([res('api', true)], now + 5 * MIN, T);
    expect((await s.snapshot(now + 5 * MIN)).active).toHaveLength(1);
    expect((await s.record([res('api', true)], now + 6 * MIN, T)).resolved).toHaveLength(1);

    const snap = await s.snapshot(now + 7 * MIN);
    expect(snap.active).toHaveLength(0);
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0].status).toBe('resolved');
    expect(snap.recent[0].resolvedAt).not.toBeNull();
    expect(snap.overall).not.toBe('outage');
  });

  it('keeps components independent', async () => {
    const now = Date.now();
    const s = stub();
    for (let i = 0; i < 3; i++)
      await s.record([res('api', false), res('docs', true)], now + i * MIN, T);
    const snap = await s.snapshot(now + 4 * MIN);
    expect(snap.components.find(c => c.id === 'docs')!.status).toBe('operational');
    expect(snap.components.find(c => c.id === 'api')!.status).toBe('outage');
  });
});

describe('end to end: forced probe failure -> incident on the public page', () => {
  it('opens an incident after 3 failed cron rounds and shows it in HTML (en + ar) and JSON; recovery resolves it', async () => {
    expect(thresholdsFrom(env)).toEqual({ fail: 3, recover: 2 });
    const now = Date.now();

    // Two failed rounds: still no incident, page shows everything fine.
    await runProbes(env, { fetcher: apiDown, now });
    await runProbes(env, { fetcher: apiDown, now: now + MIN });
    let html = await (await get('/en')).text();
    expect(has(html, 'All systems operational')).toBe(true);
    expect(has(html, 'API is not responding')).toBe(false);

    // Third failed round: incident opens.
    const out = await runProbes(env, { fetcher: apiDown, now: now + 2 * MIN });
    expect(out.opened).toHaveLength(1);

    html = await (await get('/en')).text();
    expect(has(html, 'Some services are down')).toBe(true);
    expect(has(html, 'API is not responding')).toBe(true);
    expect(has(html, '3 consecutive probes failed')).toBe(true);
    const ar = await (await get('/')).text();
    expect(has(ar, 'فيه خدمات واقفة دلوقتي')).toBe(true);
    expect(has(ar, 'مفيش رد من واجهة البرمجة')).toBe(true);
    // content audit C7: the Arabic page never shows the raw English probe error
    expect(ar).not.toMatch(
      /timeout after|consecutive probes|status \d+, expected|body did not match|fetch failed/
    );
    expect(has(ar, 'dir="rtl"')).toBe(true);

    const snap = await snapshot();
    expect(snap.overall).toBe('outage');
    expect(snap.active).toHaveLength(1);
    expect(snap.components.find(c => c.id === 'marketing')!.status).toBe('operational');

    // Recovery: two healthy rounds resolve it.
    await runProbes(env, { fetcher: healthy, now: now + 3 * MIN });
    await runProbes(env, { fetcher: healthy, now: now + 4 * MIN });
    html = await (await get('/en')).text();
    expect(has(html, 'All systems operational')).toBe(true);
    expect(has(html, 'Resolved')).toBe(true);
    expect((await snapshot()).active).toHaveLength(0);
  });

  it('a probe that times out counts as a failure and opens an incident', async () => {
    const hang: Fetcher = url =>
      url.includes('docs.ebda.app') ? new Promise<Response>(() => undefined) : healthy(url);
    const now = Date.now();
    for (let i = 0; i < 3; i++)
      await runProbes(env, { fetcher: hang, now: now + i * MIN, timeoutMs: 40 });
    const snap = await snapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0].component).toBe('docs');
    expect(snap.active[0].updates[0].body).toContain('timeout after 40ms');
  });

  it('serves the page with two same-origin scripts (the shared nav and the optional search) and a restrictive CSP', async () => {
    const r = await get('/en');
    const html = await r.text();
    // the JSON-LD blocks are data (never run, so CSP does not apply); strip them before counting scripts
    const scripts = html.replace(/<script type="application\/ld\+json">.*?<\/script>/gs, '');
    expect(scripts.match(/<script\b[^>]*>/gi)).toEqual([
      '<script src="/assets/site-nav.js" defer>',
      '<script src="/assets/typeahead.js" defer>',
    ]);
    expect(
      /<script\b[^>]*>\s*\S/i.test(scripts.replace(/<script src="[^"]*" defer><\/script>/g, ''))
    ).toBe(false);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(has(html, 'role="search"')).toBe(true);
    expect(has(html, 'lang="en"')).toBe(true);
  });

  it('serves the shared header-nav script as a same-origin file, byte for byte', async () => {
    const r = await get('/assets/site-nav.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await r.text()).toBe(SITE_NAV_JS);
  });
});

describe('header search (components, incidents, help)', () => {
  it('serves the search script itself, and the page data in both languages', async () => {
    const js = await get('/assets/typeahead.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await js.text()).length).toBeGreaterThan(5000);
    for (const [lang, name] of [
      ['en', 'Merchant dashboard'],
      ['ar', 'لوحة التحكم'],
    ] as const) {
      const r = await get(`/search.json?lang=${lang}`);
      expect(r.status).toBe(200);
      const docs = (await r.json()) as { id: string; title: string; section: string }[];
      const hit = docs.find(d => d.title === name);
      expect(hit?.id.includes('#c-')).toBe(true);
      expect(docs.every(d => d.id.startsWith(lang === 'ar' ? '/#' : '/en#'))).toBe(true);
    }
  });

  it('the page carries anchors for the results and the form points at the help search', async () => {
    const html = await (await get('/en')).text();
    expect(has(html, 'id="c-admin"')).toBe(true);
    expect(has(html, 'action="https://help.ebda.app/en/search/"')).toBe(true);
    expect(has(html, '/search.json?lang=en||docs')).toBe(true);
  });
});

describe('trust details (audit UI-2, UI-9)', () => {
  it('the footer year is the request-time year, never 1970 (the Worker clock is frozen at module scope)', async () => {
    const year = String(new Date().getUTCFullYear());
    for (const path of ['/', '/en']) {
      const html = await (await get(path)).text();
      expect(has(html, `© ${year}`)).toBe(true);
      expect(has(html, '1970')).toBe(false);
    }
  });

  it('HTML is no-transform, so the zone does not inject an analytics beacon the CSP blocks', async () => {
    expect((await get('/en')).headers.get('cache-control')).toContain('no-transform');
  });

  it('probes a storefront product page on its own (UI-7)', () => {
    expect(
      COMPONENTS.some(c => c.id === 'storefront-product' && c.url.includes('/products/'))
    ).toBe(true);
  });
});

describe('manual incidents (authenticated POST)', () => {
  const post = (path: string, payload: unknown, secret?: string) =>
    worker.fetch(
      new Request(`https://status.ebda.app${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-status-secret': secret } : {}),
        },
        body: JSON.stringify(payload),
      }),
      env
    );
  const valid = {
    title: 'Scheduled maintenance',
    body: 'Database upgrade.',
    impact: 'degraded',
    component: 'api',
  };

  it('rejects missing and wrong secrets', async () => {
    expect((await post('/api/incidents', valid)).status).toBe(401);
    expect((await post('/api/incidents', valid, 'nope')).status).toBe(401);
  });

  it('fails closed when no secret is configured', async () => {
    const r = await worker.fetch(
      new Request('https://status.ebda.app/api/incidents', {
        method: 'POST',
        headers: { 'x-status-secret': 'anything' },
        body: JSON.stringify(valid),
      }),
      { ...env, STATUS_SECRET: undefined }
    );
    expect(r.status).toBe(401);
  });

  it('creates, updates and resolves an incident that shows on the page', async () => {
    await runProbes(env, { fetcher: healthy, now: Date.now() }); // everything healthy first
    const created = await post(
      '/api/incidents',
      { ...valid, titleAr: 'صيانة مجدولة', bodyAr: 'ترقية قاعدة البيانات.' },
      'test-secret'
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: number } };

    let html = await (await get('/en')).text();
    expect(has(html, 'Scheduled maintenance')).toBe(true);
    expect(has(html, 'Some services are degraded')).toBe(true);
    expect(has(await (await get('/')).text(), 'صيانة مجدولة')).toBe(true);

    const upd = await post(
      `/api/incidents/${data.id}/updates`,
      { status: 'resolved', body: 'Done.' },
      'test-secret'
    );
    expect(upd.status).toBe(200);
    html = await (await get('/en')).text();
    expect(has(html, 'All systems operational')).toBe(true);
    expect((await snapshot()).recent[0].updates[0]).toMatchObject({
      status: 'resolved',
      body: 'Done.',
    });
  });

  it('validates input', async () => {
    expect((await post('/api/incidents', { ...valid, impact: 'meh' }, 'test-secret')).status).toBe(
      400
    );
    expect(
      (await post('/api/incidents', { ...valid, component: 'nope' }, 'test-secret')).status
    ).toBe(400);
    expect((await post('/api/incidents', { ...valid, title: '' }, 'test-secret')).status).toBe(400);
    expect(
      (await post('/api/incidents/9999/updates', { status: 'resolved', body: 'x' }, 'test-secret'))
        .status
    ).toBe(404);
  });
});

describe('404 (the studio page for people, JSON for API clients)', () => {
  const html = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`https://status.ebda.app${path}`, {
        headers: { accept: 'text/html', ...headers },
      }),
      env
    );

  it('a browser on a missing path gets a real 404 studio page: noindex, search box, links', async () => {
    const r = await html('/no-such-page', { 'accept-language': 'en' });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    const page = await r.text();
    expect(page.includes('The page you&#39;re looking for can&#39;t be found.')).toBe(true);
    expect(page.includes('role="search"')).toBe(true);
    expect(page.includes('href="https://help.ebda.app/en/"')).toBe(true);
    expect(page.includes('href="https://status.ebda.app/"')).toBe(true);
  });

  it('Arabic by default, and an API client or an /api path keeps the JSON 404', async () => {
    expect((await (await html('/zzz')).text()).includes('dir="rtl"')).toBe(true);
    const api = await html('/api/nope');
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
    const json = await worker.fetch(new Request('https://status.ebda.app/zzz'), env);
    expect(json.status).toBe(404);
    expect(json.headers.get('content-type')).toContain('application/json');
  });
});

describe('90-day history', () => {
  it('rolls checks up per UTC day, computes uptime and prunes rows older than 90 days', async () => {
    const now = Date.now();
    const s = stub();
    await s.record([res('docs', true)], now - 120 * DAY, T); // outside retention
    await s.record([res('docs', true)], now - 2 * DAY, T);
    await s.record([res('docs', true)], now - 2 * DAY, T);
    await s.record([res('docs', true)], now - 2 * DAY, T);
    await s.record([res('docs', false)], now, T);

    const snap = await s.snapshot(now);
    const docs = snap.components.find(c => c.id === 'docs')!;
    expect(docs.days).toHaveLength(90);
    expect(docs.uptime).toBe(75);
    expect(docs.days.at(-1)).toMatchObject({ checks: 1, ok: 0 });
    expect(docs.days.at(-3)).toMatchObject({ checks: 3, ok: 3 });

    const old = await runInDurableObject(
      s,
      (_i, state) =>
        state.storage.sql
          .exec(
            `SELECT COUNT(*) AS n FROM daily WHERE day < ?`,
            new Date(now - 91 * DAY).toISOString().slice(0, 10)
          )
          .one().n
    );
    expect(old).toBe(0);
  });
});

describe('thresholdsFrom', () => {
  it('reads positive integers and ignores junk', () => {
    expect(thresholdsFrom({ ...env, FAIL_THRESHOLD: '5', RECOVER_THRESHOLD: '1' })).toEqual({
      fail: 5,
      recover: 1,
    });
    expect(thresholdsFrom({ ...env, FAIL_THRESHOLD: '0', RECOVER_THRESHOLD: 'x' })).toEqual({
      fail: 3,
      recover: 2,
    });
  });
});

describe('master brand, products and discovery files (BRAND-ARCH-1, 6c)', () => {
  it('is titled "Ebda AI Studio Status" and lists components per product', async () => {
    const en = await (await get('/en')).text();
    expect(en).toContain('<title>Ebda AI Studio Status</title>');
    expect(en).toMatch(/<h3 id="prod-store">Ebda Store<\/h3>/);
    expect(en).toMatch(/<h3 id="prod-studio">Ebda AI Studio<\/h3>/);
    const ar = await (await get('/')).text();
    expect(ar).toContain('حالة خدمات ابدأ ستوديو');
    expect(ar).toContain('ابدأ ستور</h3>');
    expect(ar).not.toMatch(/قريب|coming soon/i);
  });

  it('every component belongs to a listed product', async () => {
    const { PRODUCTS } = await import('../src/config');
    for (const c of COMPONENTS) expect(PRODUCTS.map(p => p.id)).toContain(c.product);
  });

  it('serves its own robots, sitemap and security.txt', async () => {
    const robots = await (await get('/robots.txt')).text();
    expect(robots).toContain('Sitemap: https://status.ebda.app/sitemap.xml');
    const map = await (await get('/sitemap.xml')).text();
    expect(map).toContain('<loc>https://status.ebda.app/</loc>');
    expect(map).toContain('<loc>https://status.ebda.app/en</loc>');
    const sec = await (await get('/.well-known/security.txt')).text();
    expect(sec).toMatch(/^Contact: mailto:security@ebda\.app$/m);
    expect(sec).toContain('Canonical: https://status.ebda.app/.well-known/security.txt');
    const exp = new Date(/^Expires: (.+)$/m.exec(sec)![1]).getTime();
    expect(exp - Date.now()).toBeGreaterThan(90 * 86_400_000);
  });
});

describe('human alerting (OPS-5)', () => {
  const sent: { url: string; body: string }[] = [];
  const send = async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  };
  const withSecrets = {
    ...env,
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_ALERT_CHAT_ID: '42',
  } as typeof env;

  it('sends one Telegram message naming the component when an incident opens', async () => {
    sent.length = 0;
    const t0 = Date.now();
    let outcome = { opened: [] as number[], resolved: [] as number[] };
    for (let i = 0; i < 3; i++)
      outcome = await runProbes(env, { fetcher: apiDown, now: t0 + i * MIN });
    expect(outcome.opened.length).toBe(1);
    expect(await alertOnOutcome(withSecrets, outcome, send)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/bott/sendMessage');
    expect(sent[0].body).toContain('DOWN');
    expect(sent[0].body).toContain('"chat_id":"42"');
  });

  it('says RECOVERED when it resolves', async () => {
    sent.length = 0;
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) await runProbes(env, { fetcher: apiDown, now: t0 + i * MIN });
    let outcome = { opened: [] as number[], resolved: [] as number[] };
    for (let i = 3; i < 5; i++)
      outcome = await runProbes(env, { fetcher: healthy, now: t0 + i * MIN });
    expect(outcome.resolved.length).toBe(1);
    await alertOnOutcome(withSecrets, outcome, send);
    expect(sent[0].body).toContain('RECOVERED');
  });

  it('is a no-op (false) without the secrets, and when nothing changed', async () => {
    sent.length = 0;
    expect(await alertOnOutcome(env, { opened: [1], resolved: [] }, send)).toBe(false);
    expect(await alertOnOutcome(withSecrets, { opened: [], resolved: [] }, send)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('probes the orders and accounts Workers too (M-070)', () => {
    const ids = COMPONENTS.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining(['orders', 'accounts']));
  });
});

describe('llms.txt (audit M-119)', () => {
  it('says what the host is and links the page and the JSON feed', async () => {
    const r = await get('/llms.txt');
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('# Ebda AI Studio Status');
    expect(t).toContain('https://status.ebda.app/en');
    expect(t).toContain('https://status.ebda.app/api/status.json');
  });
});

describe('HSTS (Ruling HSTS-ALL-1)', () => {
  const HSTS = 'max-age=31536000; includeSubDomains; preload';
  it.each([
    ['/en', 'text/html'],
    ['/', 'text/html'],
    ['/healthz', ''],
    ['/api/status.json', ''],
    ['/search.json', ''],
    ['/assets/site-nav.js', ''],
    ['/assets/typeahead.js', ''],
    ['/robots.txt', ''],
    ['/.well-known/security.txt', ''],
    ['/api/nope', ''],
    ['/nope', 'text/html'],
  ])('%s carries the same HSTS policy as the other hosts', async (path, accept) => {
    const r = await worker.fetch(
      new Request(`https://status.ebda.app${path}`, accept ? { headers: { accept } } : {}),
      env
    );
    expect(r.headers.get('strict-transport-security')).toBe(HSTS);
  });
});
