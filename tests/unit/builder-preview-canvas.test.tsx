/**
 * Visual builder Phase 2 — the storefront canvas side:
 *  - the token-gated draft preview API (mint behind admin auth, read by token,
 *    store-scoped Redis key, never cacheable, 404 on unknown/malformed token);
 *  - the canvas only trusts the admin origins the storefront may be framed by
 *    (same list as the frame-ancestors in apps/web/src/lib/csp.ts);
 *  - overlay logic (section lookup, exact-match inline setting, union boxes);
 *  - PageRenderer renders the document-only sections, and emits editor
 *    markers ONLY in editor mode (public markup unchanged);
 *  - the newsletter section carries the platform consent line and is inert
 *    in the canvas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  layoutToDefinition,
  resolveLayoutSettings,
  reduceDocument,
  type PageDefinition,
} from '@ebda/shared';

const m = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  getPreviewDefinition: vi.fn(),
  ctx: { language: 'en' as 'en' | 'ar' },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    set: vi.fn(async (k: string, v: unknown, ttl: number) => {
      m.store.set(k, { v, ttl });
    }),
    get: vi.fn(async (k: string) => (m.store.get(k) as { v: unknown } | undefined)?.v ?? null),
  },
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/page-builder.service', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, getPreviewDefinition: m.getPreviewDefinition };
});

// storefront contexts for the render tests
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's', name: 'S', theme: {}, currency: 'EGP' },
    isPlatform: false,
  }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: m.ctx.language,
      isRtl: m.ctx.language === 'ar',
      t: (en: string, ar: string) => (m.ctx.language === 'ar' ? ar : en),
    }),
  };
});

import builderRoutes from '@api/routes/page-builder.routes';
import publicLayoutRoutes from '@api/routes/public-store-layout.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { allowedParentOrigins } from '../../apps/web/src/builder/preview/allowed-parent-origins';
import {
  inlineSettingFor,
  sectionIdOf,
  unionRect,
  type ElementLike,
} from '../../apps/web/src/builder/preview/overlay-logic';
import { ImageTextSection } from '../../apps/web/src/builder/sections/ImageTextSection';
import { NewsletterSection } from '../../apps/web/src/builder/sections/NewsletterSection';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const doc = (): PageDefinition => layoutToDefinition(resolveLayoutSettings({}, 'qamar'));

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin/stores/:storeId/builder', builderRoutes);
  a.use('/public', publicLayoutRoutes);
  a.use(errorHandler);
  return a;
}

describe('draft preview token API', () => {
  beforeEach(() => {
    m.store.clear();
    m.getPreviewDefinition.mockResolvedValue({ definition: doc(), rev: 3 });
  });

  it('mints a 192-bit token into a store-scoped Redis key with a >=120s TTL', async () => {
    const res = await request(app())
      .post(`/admin/stores/${STORE}/builder/pages/home/preview-token`)
      .send({});
    expect(res.status).toBe(200);
    const { token, expiresIn } = res.body.data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(expiresIn).toBeGreaterThanOrEqual(120);
    expect([...m.store.keys()]).toEqual([`builder-preview:${STORE}:${token}`]);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('the public read returns the draft for the right store + token, uncacheable', async () => {
    const { token } = (
      await request(app()).post(`/admin/stores/${STORE}/builder/pages/home/preview-token`).send({})
    ).body.data;
    const res = await request(app()).get(`/public/stores/${STORE}/builder-preview?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rev).toBe(3);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(m.getPreviewDefinition).toHaveBeenCalledWith(STORE, 'home');
  });

  it("another store's id, a wrong, missing or malformed token -> 404 and no read", async () => {
    const { token } = (
      await request(app()).post(`/admin/stores/${STORE}/builder/pages/home/preview-token`).send({})
    ).body.data;
    for (const url of [
      `/public/stores/${OTHER}/builder-preview?token=${token}`,
      `/public/stores/${STORE}/builder-preview?token=${'x'.repeat(32)}`,
      `/public/stores/${STORE}/builder-preview`,
      `/public/stores/${STORE}/builder-preview?token=..%2F..%2Fx`,
    ]) {
      const res = await request(app()).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    expect(m.getPreviewDefinition).not.toHaveBeenCalled();
  });
});

describe('canvas origins', () => {
  it('match the storefront frame-ancestors (same env var, same defaults)', () => {
    const cfg = readFileSync(join(__dirname, '../../apps/web/src/lib/csp.ts'), 'utf8');
    expect(cfg).toContain("'https://store.ebda.app'");
    expect(cfg).toContain("'https://store.ebda.app http://localhost:3001 http://localhost:3000'");
    expect(allowedParentOrigins({ NODE_ENV: 'production' })).toEqual(['https://store.ebda.app']);
    expect(allowedParentOrigins({ NODE_ENV: 'development' })).toContain('http://localhost:3001');
    expect(
      allowedParentOrigins({
        STOREFRONT_FRAME_ANCESTORS: 'https://a.example  bogus https://b.example/x',
      })
    ).toEqual(['https://a.example']);
  });

  it('the overlay accepts a message only from an allowed origin AND window.parent', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/builder/preview/EditorOverlay.tsx'),
      'utf8'
    );
    expect(src).toMatch(/if \(!allowedOrigins\.includes\(event\.origin\)\) return;/);
    expect(src).toMatch(
      /acceptMessage\(event, event\.origin, window\.parent, parentToChildSchema\)/
    );
  });

  it('the overlay is code-split and only mounted by the preview shell', () => {
    const shell = readFileSync(
      join(__dirname, '../../apps/web/src/builder/preview/BuilderPreviewShell.tsx'),
      'utf8'
    );
    expect(shell).toMatch(/dynamic\(\(\) => import\('\.\/EditorOverlay'\), \{ ssr: false \}\)/);
    const body = readFileSync(join(__dirname, '../../apps/web/src/app/HomePageBody.tsx'), 'utf8');
    expect(body).toMatch(/builderToken \? fetchBuilderPreview/);
    const page = readFileSync(join(__dirname, '../../apps/web/src/app/page.tsx'), 'utf8');
    expect(page).toMatch(/'_preview' in params/);
  });
});

describe('overlay logic', () => {
  const el = (attrs: Record<string, string>, text: string, parent?: ElementLike): ElementLike => {
    const self: ElementLike = {
      textContent: text,
      getAttribute: n => attrs[n] ?? null,
      closest: sel => {
        const attr = /\[(.+)\]/.exec(sel)![1];
        if (attr in attrs) return self;
        return parent ? parent.closest(sel) : null;
      },
    };
    return self;
  };

  it('finds the section id up the tree', () => {
    const section = el({ 'data-builder-id': 'categories' }, '');
    expect(sectionIdOf(el({}, 'x', section))).toBe('categories');
    expect(sectionIdOf(el({}, 'x'))).toBeNull();
  });

  it('inline edit targets ONLY an exact, unique text-setting match (never guesses)', () => {
    let d = doc();
    d = reduceDocument(d, {
      type: 'setSectionSetting',
      id: 'categories',
      key: 'title',
      value: 'Shop now',
    }).doc;
    d = reduceDocument(d, {
      type: 'setSectionSetting',
      id: 'categories',
      key: 'titleAr',
      value: 'تسوق',
    }).doc;
    const section = el({ 'data-builder-id': 'categories' }, '');
    expect(inlineSettingFor(el({}, ' Shop now ', section), d, 'categories', 'en')).toBe('title');
    expect(inlineSettingFor(el({}, 'تسوق', section), d, 'categories', 'ar')).toBe('titleAr');
    expect(inlineSettingFor(el({}, 'Shop by Category', section), d, 'categories', 'en')).toBeNull();
    // ambiguous: title and subtitle carry the same text -> no edit
    d = reduceDocument(d, {
      type: 'setSectionSetting',
      id: 'categories',
      key: 'subtitle',
      value: 'Shop now',
    }).doc;
    expect(inlineSettingFor(el({}, 'Shop now', section), d, 'categories', 'en')).toBeNull();
    // explicit marker wins, but only for a real text setting
    expect(
      inlineSettingFor(
        el({ 'data-builder-setting': 'kicker' }, 'x', section),
        d,
        'categories',
        'en'
      )
    ).toBe('kicker');
    expect(
      inlineSettingFor(
        el({ 'data-builder-setting': 'bgColor' }, 'x', section),
        d,
        'categories',
        'en'
      )
    ).toBeNull();
  });

  it('a display:contents wrapper is boxed by the union of its children', () => {
    expect(
      unionRect([
        { top: 10, left: 0, width: 100, height: 20 },
        { top: 40, left: 5, width: 50, height: 10 },
      ])
    ).toEqual({ top: 10, left: 0, width: 100, height: 40 });
    expect(unionRect([{ top: 0, left: 0, width: 0, height: 0 }])).toBeNull();
  });
});

describe('document-only section renderers', () => {
  it('image-text: logical image side, Arabic copy in ar, inline markers only in the editor', () => {
    m.ctx.language = 'ar';
    const s = {
      heading: 'Story',
      headingAr: 'حكايتنا',
      body: 'b',
      imagePosition: 'end' as const,
      image: 'https://media.ebda.app/a.jpg',
      buttonText: 'Go',
      buttonLink: 'javascript:alert(1)',
    };
    const pub = renderToStaticMarkup(<ImageTextSection settings={s} />);
    expect(pub).toContain('حكايتنا');
    expect(pub).not.toContain('data-builder-setting');
    expect(pub).not.toContain('javascript:');
    expect(pub).toMatch(/md:order-2[^"]*"><img/);
    const ed = renderToStaticMarkup(<ImageTextSection settings={s} editorMode />);
    expect(ed).toContain('data-builder-setting="headingAr"');
    m.ctx.language = 'en';
  });

  it('newsletter: platform consent line + privacy link always; inert in the canvas', () => {
    const pub = renderToStaticMarkup(<NewsletterSection settings={{ heading: 'Join' }} />);
    expect(pub).toContain('By subscribing you agree to receive marketing emails from this store.');
    expect(pub).toContain('href="/privacy"');
    expect(pub).not.toMatch(/disabled=""/);
    const ed = renderToStaticMarkup(
      <NewsletterSection settings={{ heading: 'Join' }} editorMode />
    );
    expect(ed).toMatch(/disabled=""/);
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/builder/sections/NewsletterSection.tsx'),
      'utf8'
    );
    expect(src).toMatch(/source: 'section'/);
    expect(src).toMatch(/if \(editorMode\) return;/);
  });
});
