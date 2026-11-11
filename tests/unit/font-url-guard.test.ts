/**
 * Cross-tenant font URLs. A font in a store's typography is a merchant-supplied URL and, when it later
 * leaves the library, the platform deletes the object behind it. So a store may only name:
 *   - its OWN uploaded font file (`stores/<storeId>/fonts/...` in our bucket), or
 *   - an allowlisted Google stylesheet.
 * Anything else is refused on every page-document write and on the typography PUT. (The delete refuses
 * a foreign key as well: `r2-cleanup-store-prefix.test.ts`.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

const m = vi.hoisted(() => ({
  bustStoreCaches: vi.fn(),
  store: { findUnique: vi.fn(), update: vi.fn() },
  rev: {
    findFirst: vi.fn(),
    aggregate: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
  typographyUpdate: vi.fn(),
}));
vi.mock('../../apps/api/src/config', () => ({
  config: { storagePublicUrl: 'https://cdn.example.com', storageEndpoint: '', storageBucket: '' },
}));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: m.bustStoreCaches }));
vi.mock('@api/services/r2-cleanup.service', async importOriginal => {
  // the real key helpers, a stubbed delete (this file is about what may be SAVED)
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    cleanupRemovedJsonUrls: vi.fn().mockResolvedValue(undefined),
    deleteR2ObjectIfOrphan: vi.fn(),
  };
});
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (_n: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('@api/lib/savepoint', () => ({ withSavepoint: (fn: () => Promise<unknown>) => fn() }));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_r: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateCached: vi.fn() }));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const prisma = {
    store: { ...m.store, update: m.typographyUpdate },
    storePageRevision: m.rev,
    category: { findMany: vi.fn().mockResolvedValue([]) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    ...actual,
    prisma,
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma),
  };
});

import { fontLibraryProblems, fontUrlProblem } from '@api/lib/font-url-guard';
import pageBuilderRoutes from '@api/routes/page-builder.routes';
import typographyRoutes from '@api/routes/typography.routes';
import { errorHandler } from '@api/middleware/error-handler';

const CDN = 'https://cdn.example.com';
const OWN = {
  type: 'custom' as const,
  family: 'Mine',
  url: `${CDN}/stores/store-a/fonts/mine.woff2`,
  format: 'woff2' as const,
};
const FOREIGN = { ...OWN, family: 'Theirs', url: `${CDN}/stores/store-b/fonts/theirs.woff2` };
const GOOGLE = {
  type: 'google' as const,
  family: 'Tajawal',
  url: 'https://fonts.googleapis.com/css2?family=Tajawal',
};

describe('fontUrlProblem', () => {
  it('accepts the store`s own upload and an allowlisted Google stylesheet', () => {
    expect(fontUrlProblem('store-a', OWN)).toBeNull();
    expect(fontUrlProblem('store-a', GOOGLE)).toBeNull();
  });
  it('refuses another store`s file, a look-alike store id, a non-font folder and a foreign host', () => {
    expect(fontUrlProblem('store-a', FOREIGN)).toBeTruthy();
    expect(
      fontUrlProblem('store-a', { ...OWN, url: `${CDN}/stores/store-ab/fonts/x.woff2` })
    ).toBeTruthy();
    expect(
      fontUrlProblem('store-a', { ...OWN, url: `${CDN}/stores/store-a/images/x.woff2` })
    ).toBeTruthy();
    expect(
      fontUrlProblem('store-a', { ...OWN, url: 'https://evil.test/stores/store-a/fonts/x.woff2' })
    ).toBeTruthy();
    expect(
      fontUrlProblem('store-a', {
        ...OWN,
        url: `${CDN}/stores/store-a/fonts/../../store-b/fonts/x.woff2`,
      })
    ).toBeTruthy();
  });
  it('refuses a Google font off the allowlisted origin', () => {
    expect(
      fontUrlProblem('store-a', { ...GOOGLE, url: 'https://fonts.googleapis.com.evil.test/css' })
    ).toBeTruthy();
    expect(
      fontUrlProblem('store-a', { ...GOOGLE, url: `${CDN}/stores/store-a/fonts/x.css` })
    ).toBeTruthy();
  });
  it('reports each refused font of a library with its index', () => {
    expect(fontLibraryProblems('store-a', [OWN, FOREIGN, GOOGLE]).map(p => p.index)).toEqual([1]);
    expect(fontLibraryProblems('store-a', undefined)).toEqual([]);
  });
});

const BASE = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const pageApp = () => {
  const a = express();
  a.use(express.json());
  a.use('/admin/stores/:storeId/builder', pageBuilderRoutes);
  a.use(errorHandler);
  return a;
};
const typoApp = () => {
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/typography', typographyRoutes);
  a.use(errorHandler);
  return a;
};

describe('the page document refuses a foreign font, on save, publish and rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue({
      layoutSettings: {},
      template: 'qamar',
      slug: 's',
      domain: null,
      theme: {},
      typography: null,
    });
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    m.rev.findFirst.mockResolvedValue(null);
  });

  it('store A saving store B`s font URL is a 422 and writes nothing', async () => {
    const res = await request(pageApp())
      .put('/admin/stores/store-a/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, typography: { fonts: [FOREIGN] } } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('/typography/fonts/0/url');
    expect(m.rev.updateMany).not.toHaveBeenCalled();
  });

  it('its own font and a Google font save fine', async () => {
    const res = await request(pageApp())
      .put('/admin/stores/store-a/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, typography: { fonts: [OWN, GOOGLE] } } });
    expect(res.status).toBe(200);
  });

  it('a draft that already holds a foreign font (written before this check) cannot be PUBLISHED', async () => {
    m.rev.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.status === 'draft'
          ? {
              id: 'd1',
              rev: 3,
              status: 'draft',
              document: { ...BASE, typography: { fonts: [FOREIGN] } },
            }
          : null
      )
    );
    const res = await request(pageApp())
      .post('/admin/stores/store-a/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(422);
    expect(m.store.update).not.toHaveBeenCalled();
    expect(m.typographyUpdate).not.toHaveBeenCalled();
  });
});

// Ruling TYPO-WRITER-1: the typography route no longer writes. A foreign font can only enter through the page
// document, whose save/publish/rollback guard is covered above, so the old PUT must be gone, not merely guarded.
describe('PUT /stores/:id/typography is gone (single writer = builder publish)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('answers 404 for a foreign font and for its own font, and stores nothing', async () => {
    for (const font of [FOREIGN, OWN]) {
      const res = await request(typoApp())
        .put('/stores/store-a/typography')
        .send({ fonts: [font], zones: {} });
      expect(res.status).toBe(404);
    }
    expect(m.typographyUpdate).not.toHaveBeenCalled();
  });
});
