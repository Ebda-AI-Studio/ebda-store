/**
 * Integration test for Task 6: BlogService.update captures slug renames
 * as SlugRedirect rows.
 *
 * Exercises the real BlogService against the real DB (no mocked prisma),
 * wrapped in runInTenantContext to mirror the production RLS path
 * (blog_posts is a tenant table with RLS enabled).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, runInTenantContext, SlugEntityType } from '@force/database';
import { BlogService } from '../../apps/api/src/services/blog.service';

const EMAIL = `blog-slug-redirect-test-${Date.now()}@example.test`;
let STORE = '';
let userId = '';
let postId = '';

describe('BlogService.update slug redirect capture', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: 'hashed',
        firstName: 'Blog',
        lastName: 'SlugRedirect',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Blog Slug Redirect Test Store',
        slug: `blog-slug-redirect-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    STORE = store.id;
  });

  afterAll(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
    await prisma.blogPost.deleteMany({ where: { storeId: STORE } });
    await prisma.store.deleteMany({ where: { id: STORE } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
    await prisma.blogPost.deleteMany({ where: { storeId: STORE } });

    const post = await runInTenantContext(STORE, () =>
      BlogService.create(STORE, {
        slug: 'old-post-2636297',
        title: 'Old Post',
        content: 'Original content.',
      })
    );
    postId = post.id;
  });

  it('renaming a blog post slug records a BLOG redirect', async () => {
    await runInTenantContext(STORE, () => BlogService.update(STORE, postId, { slug: 'new-post' }));

    const row = await prisma.slugRedirect.findFirst({
      where: { storeId: STORE, entityType: SlugEntityType.BLOG, fromSlug: 'old-post-2636297' },
    });
    expect(row?.toSlug).toBe('new-post');
  });

  it('updating a blog post without changing the slug creates no redirect row', async () => {
    await runInTenantContext(STORE, () =>
      BlogService.update(STORE, postId, { title: 'Old Post Deluxe' })
    );

    const count = await prisma.slugRedirect.count({
      where: { storeId: STORE, entityType: SlugEntityType.BLOG },
    });
    expect(count).toBe(0);
  });
});
