/**
 * LAUNCH-RL-MISS-3: the blog-post 404 that the store-miss limiter leaves uncounted must say nothing.
 *
 * `GET /public/:storeId/blog/:slug` is on the catalogue-miss list, so a caller can ask it about slugs outside the 20 per
 * minute store-miss budget. That is only acceptable if its 404 cannot tell a DRAFT, a post that belongs to ANOTHER STORE
 * and a slug that NEVER EXISTED apart: same status, byte-equal body. This file drives the real blog router and the real
 * `BlogService` over a fake read client that applies every key of the `where` it is given, so the test goes red if the
 * route starts answering those three cases differently (or drops `isPublished` / `storeId` from the read).
 *
 * The product route's twin of this pin runs on workerd over the real store: apps/api/workers-test/failure-only-limiters.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';

const db = vi.hoisted(() => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const post = (storeId: string, slug: string, isPublished: boolean) => ({
    id: `${slug}-id`,
    storeId,
    slug,
    title: slug,
    titleAr: null,
    excerpt: null,
    excerptAr: null,
    content: 'body',
    contentAr: null,
    coverImage: null,
    isPublished,
    publishedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  return {
    stores: [
      { id: A, blogEnabled: true },
      { id: B, blogEnabled: true },
    ] as Record<string, unknown>[],
    posts: [post(A, 'a-live', true), post(A, 'a-draft', false), post(B, 'b-live', true)] as Record<
      string,
      unknown
    >[],
    wheres: [] as Record<string, unknown>[],
  };
});

/** A read client that honours EVERY key of `where` and returns only the selected fields, as the real ones do. */
function reads(rows: Record<string, unknown>[]) {
  const find = async (args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }) => {
    db.wheres.push(args.where);
    const row = rows.find(r => Object.entries(args.where).every(([k, v]) => r[k] === v));
    if (!row) return null;
    if (!args.select) return row;
    return Object.fromEntries(Object.keys(args.select).map(k => [k, row[k]]));
  };
  return { findFirst: find, findUnique: find };
}

vi.mock('@ebda/database', () => ({ prisma: {}, SlugEntityType: { blog: 'blog' } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: reads(db.stores), blogPost: reads(db.posts) }),
  storeWriter: async () => ({}),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  writeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/services/r2-cleanup.service', () => ({ deleteR2ObjectIfOrphan: vi.fn() }));
vi.mock('@api/services/slug-redirect.service', () => ({ recordSlugRedirect: vi.fn() }));

import blogRoutes from '@api/routes/blog.routes';

const MISS = '{"success":false,"error":{"code":"NOT_FOUND","message":"Blog post not found"}}';

function get(storeId: string, slug: string) {
  const a = express();
  a.use('/', blogRoutes);
  return request(a).get(`/public/${storeId}/blog/${slug}`);
}

describe('blog post by slug: a miss says nothing about why', () => {
  it('controls: a published post of the store is served, on both stores', async () => {
    const a = await get(STORE_A, 'a-live');
    expect(a.status).toBe(200);
    expect(a.body.data.post.slug).toBe('a-live');
    const b = await get(STORE_B, 'b-live');
    expect(b.status).toBe(200);
    expect(b.body.data.post.slug).toBe('b-live');
  });

  it('draft = another store’s post = never existed: 404 with a byte-equal body', async () => {
    const draft = await get(STORE_A, 'a-draft');
    const otherStore = await get(STORE_A, 'b-live');
    const never = await get(STORE_A, 'no-such-post');
    for (const res of [draft, otherStore, never]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(MISS);
      expect(res.headers['content-type']).toBe(draft.headers['content-type']);
      expect(res.headers['content-length']).toBe(draft.headers['content-length']);
    }
    // and the other way round: store B cannot see store A's posts, live or draft
    expect((await get(STORE_B, 'a-live')).text).toBe(MISS);
    expect((await get(STORE_B, 'a-draft')).text).toBe(MISS);
  });

  it('the read is scoped to the path store and to published posts', async () => {
    db.wheres.length = 0;
    await get(STORE_A, 'a-draft');
    expect(db.wheres).toEqual([
      { id: STORE_A },
      { storeId: STORE_A, slug: 'a-draft', isPublished: true },
    ]);
  });
});
