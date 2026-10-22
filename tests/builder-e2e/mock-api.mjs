/**
 * In-memory stand-in for the Ebda API, for the visual-builder E2E only.
 *
 * Implements exactly what the admin needs to boot and the builder needs to
 * work, with the SAME contracts as the real routes (envelope
 * `{ success, data | error }`, rev/409 semantics of
 * apps/api/src/services/page-builder.service.ts). Anything else answers an
 * empty success so unrelated admin chrome does not crash.
 *
 * Test-only control endpoints (never in the real API):
 *   POST /__test/reset              fresh store + page
 *   POST /__test/bump               simulate another editor saving (head rev + 1)
 *   GET  /__test/state              { rev, draft, published, saves, publishes }
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../../packages/shared/dist/index.js');

const PORT = Number(process.env.MOCK_API_PORT || 4510);
const STORE_ID = '0a0b0c0d-0000-4000-8000-00000000e2e0';

function freshState() {
  const layout = shared.resolveLayoutSettings(
    {
      hero: {
        enabled: true,
        mode: 'slider',
        autoplayMs: 5000,
        slides: [
          { image: 'https://media.ebda.app/hero.jpg', headline: 'Fresh dates', headlineAr: 'تمور طازجة' },
          { image: 'https://media.ebda.app/hero-2.jpg', headline: 'Gift boxes', headlineAr: 'علب هدايا' },
        ],
      },
      header: {},
      footer: {},
      categories: { enabled: true, layout: 'grid', captionPosition: 'below', desktopColumns: 3, mobileColumns: 2, title: 'Shop by category', titleAr: 'تسوق حسب الفئة' },
    },
    'modern'
  );
  return {
    rev: 0,
    draft: null,
    published: null,
    base: shared.layoutToDefinition(layout),
    revisions: [],
    saves: 0,
    publishes: 0,
    theme: { ...shared.DEFAULT_THEME, primaryColor: '35 34% 52%' },
  };
}
let S = freshState();

const user = { id: 'u-e2e', email: 'merchant@ebda.test', firstName: 'Mona', lastName: 'E', role: 'store_admin', storeId: null };
const store = { id: STORE_ID, name: 'Mona Dates', nameAr: 'تمور منى', slug: 'e2e-store', domain: null, status: 'active', template: 'modern', theme: S.theme };

const ok = data => ({ status: 200, body: { success: true, data } });
const fail = (status, code, message, details) => ({ status, body: { success: false, error: { code, message, ...(details ? { details } : {}) } } });

function pageState() {
  const row = S.draft ?? S.published;
  return {
    rev: S.rev,
    definition: row ? row.definition : S.base,
    source: S.draft ? 'draft' : S.published ? 'published' : 'layout',
    draftRev: S.draft?.rev ?? null,
    publishedRev: S.published?.rev ?? null,
  };
}

function route(method, path, body) {
  const p = path.replace(/^\/api\/v1/, '');
  if (method === 'POST' && p === '/__test/reset') return (S = freshState()), (store.theme = S.theme), ok({});
  if (method === 'POST' && p === '/__test/bump') {
    S.rev += 1;
    const def = structuredClone(pageState().definition);
    S.draft = { rev: S.rev, definition: def };
    return ok({ rev: S.rev });
  }
  if (method === 'GET' && p === '/__test/state') return ok({ rev: S.rev, draft: S.draft, published: S.published, saves: S.saves, publishes: S.publishes, theme: S.theme });

  if (p === '/auth/me') return ok({ user });
  if (p === '/auth/refresh') return ok({});
  if (p === '/admin/stores') return ok({ stores: [store] });
  if (p === `/admin/stores/${STORE_ID}` || p === `/stores/${STORE_ID}`) return ok({ store });
  if (method === 'PUT' && p === `/stores/${STORE_ID}/theme`) {
    S.theme = { ...S.theme, ...body };
    store.theme = S.theme;
    return ok({ theme: S.theme });
  }
  if (p === `/stores/${STORE_ID}/categories`)
    return ok({ categories: [{ id: 'c1', slug: 'dates', name: 'Dates', nameAr: 'تمور' }, { id: 'c2', slug: 'nuts', name: 'Nuts', nameAr: 'مكسرات' }] });
  if (p.startsWith(`/stores/${STORE_ID}/products`))
    return ok({ products: [{ id: 'p1', name: 'Medjool', nameAr: 'مجدول' }, { id: 'p2', name: 'Cashew', nameAr: 'كاجو' }], meta: {} });
  if (method === 'GET' && p === `/stores/${STORE_ID}/typography`)
    return ok({ typography: { fonts: [], zones: {} } });
  if (method === 'POST' && p === `/stores/${STORE_ID}/ai/section-content`)
    return ok({
      suggestion: { kicker: 'EXPLORE', kickerAr: 'استكشف', subtitle: 'Top picks', subtitleAr: 'أفضل الاختيارات' },
    });
  if (p.startsWith('/uploads/list'))
    return ok({ items: [{ key: `stores/${STORE_ID}/builder/a.jpg`, url: 'https://media.ebda.app/stores/e2e/builder/a.jpg', size: 10, lastModified: '2026-10-07T00:00:00.000Z' }], nextCursor: null });

  const base = `/admin/stores/${STORE_ID}/builder/pages/home`;
  if (method === 'GET' && p === base) return ok(pageState());
  if (method === 'POST' && p === `${base}/preview-token`) return ok({ token: 'e2e-preview-token-0000000000000000', expiresIn: 3600 });
  if (method === 'PUT' && p === `${base}/draft`) {
    if (body?.baseRev !== S.rev) return fail(409, 'REV_CONFLICT', 'The page changed', { latest: pageState() });
    const v = shared.validateDefinitionSync(body.definition);
    if (!v.ok) return fail(422, 'INVALID_DEFINITION', 'The page document is invalid', { errors: v.errors });
    S.rev += 1;
    S.draft = { rev: S.rev, definition: v.definition };
    S.saves += 1;
    return ok({ rev: S.rev, warnings: [] });
  }
  if (method === 'POST' && p === `${base}/publish`) {
    if (body?.baseRev !== S.rev) return fail(409, 'REV_CONFLICT', 'The page changed', { latest: pageState() });
    if (!S.draft) return fail(409, 'NO_DRAFT', 'There is no draft to publish.');
    if (S.published) S.revisions.push({ ...S.published, status: 'archived' });
    S.published = S.draft;
    S.draft = null;
    S.publishes += 1;
    return ok({ rev: S.published.rev, layout: {} });
  }
  if (method === 'GET' && p.startsWith(`${base}/revisions`)) {
    const rows = [
      ...(S.draft ? [{ rev: S.draft.rev, status: 'draft' }] : []),
      ...(S.published ? [{ rev: S.published.rev, status: 'published' }] : []),
      ...S.revisions.map(r => ({ rev: r.rev, status: 'archived' })),
    ].map(r => ({ ...r, note: null, createdAt: '2026-10-07T10:00:00.000Z', publishedAt: null }));
    return ok({ revisions: rows.sort((a, b) => b.rev - a.rev), nextCursor: null });
  }
  return ok({});
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const origin = req.headers.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Store-ID');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const url = new URL(req.url, 'http://x');
      const out = route(req.method, url.pathname + (url.pathname.startsWith('/api/v1/uploads/list') ? url.search : ''), body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  })
  .listen(PORT, () => console.log(`mock api on ${PORT}`));
