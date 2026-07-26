/**
 * Category Slug Redirect E2E Test
 *
 * Closes a known coverage gap: renaming a category's slug records a
 * `SlugRedirect` row via `recordSlugRedirect` — but that call is inline
 * in `category.routes.ts` PUT /:categoryId, not a separately unit-testable
 * service call site. This test drives the REAL authed HTTP route (same
 * middleware chain as production — authenticate, requirePermission,
 * requireStoreAccess, writeLimiter, tenantContext) and asserts the redirect
 * row lands in the database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma, SlugEntityType } from '@force/database';
import categoryRoutes from '@api/routes/category.routes';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';
import { tenantContext } from '@api/middleware/tenant-context';
import { createSuperAdminWithMfa, loginAsSuperAdmin } from './helpers/mfa-login';

// Mirrors the real mount in apps/api/src/routes/index.ts:
//   router.use('/stores/:storeId/categories', tenantContext, categoryRoutes);
// `authenticate` is applied per-route inside category.routes.ts itself
// (same as store.test.ts mounts storeRoutes), so it is NOT re-added here
// at the mount level — only auth/mfa routes need it at the app level.
const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/auth/mfa', mfaRoutes);
app.use('/stores/:storeId/categories', tenantContext, categoryRoutes);
app.use(errorHandler);

const superAdminUser = {
  email: `slug-redirect-admin-${Date.now()}@example.com`,
  password: 'Admin123!@#',
  firstName: 'Slug',
  lastName: 'Admin',
};

let superAdminId: string | null = null;
let superAdminToken: string | null = null;
let storeId: string | null = null;
let categoryId: string | null = null;
let unchangedCategoryId: string | null = null;

describe('Category Slug Redirect (admin PUT /stores/:storeId/categories/:categoryId)', () => {
  beforeAll(async () => {
    const hashedPassword = await import('bcryptjs').then(bcrypt =>
      bcrypt.hash(superAdminUser.password, 12)
    );

    const superAdmin = await createSuperAdminWithMfa({
      email: superAdminUser.email,
      passwordHash: hashedPassword,
      firstName: superAdminUser.firstName,
      lastName: superAdminUser.lastName,
    });
    superAdminId = superAdmin.id;

    superAdminToken = await loginAsSuperAdmin(app, superAdminUser.email, superAdminUser.password);

    const store = await prisma.store.create({
      data: {
        name: 'Slug Redirect Test Store',
        slug: `slug-redirect-store-${Date.now()}`,
        ownerId: superAdminId,
        status: 'active',
      },
    });
    storeId = store.id;

    const category = await prisma.category.create({
      data: {
        storeId,
        name: 'Old Category Name',
        slug: 'old-cat',
      },
    });
    categoryId = category.id;

    const unchangedCategory = await prisma.category.create({
      data: {
        storeId,
        name: 'Unchanged Category',
        slug: 'unchanged-cat',
      },
    });
    unchangedCategoryId = unchangedCategory.id;
  });

  afterAll(async () => {
    if (storeId) {
      await prisma.slugRedirect.deleteMany({ where: { storeId } }).catch(() => {});
    }
    if (categoryId) {
      await prisma.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (unchangedCategoryId) {
      await prisma.category.delete({ where: { id: unchangedCategoryId } }).catch(() => {});
    }
    if (storeId) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    if (superAdminId) {
      await prisma.user.delete({ where: { id: superAdminId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('records a SlugRedirect when a category slug is renamed via the admin route', async () => {
    if (!superAdminToken || !storeId || !categoryId) {
      throw new Error('Prerequisites not met');
    }

    const res = await request(app)
      .put(`/stores/${storeId}/categories/${categoryId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ slug: 'new-cat' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.category.slug).toBe('new-cat');

    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    expect(category?.slug).toBe('new-cat');

    const redirect = await prisma.slugRedirect.findFirst({
      where: { storeId, entityType: SlugEntityType.CATEGORY, fromSlug: 'old-cat' },
    });
    expect(redirect).not.toBeNull();
    expect(redirect?.toSlug).toBe('new-cat');
  });

  it('does NOT create a redirect when the update does not change the slug', async () => {
    if (!superAdminToken || !storeId || !unchangedCategoryId) {
      throw new Error('Prerequisites not met');
    }

    const res = await request(app)
      .put(`/stores/${storeId}/categories/${unchangedCategoryId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Unchanged Category Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.category.slug).toBe('unchanged-cat');

    const redirect = await prisma.slugRedirect.findFirst({
      where: { storeId, entityType: SlugEntityType.CATEGORY, fromSlug: 'unchanged-cat' },
    });
    expect(redirect).toBeNull();
  });
});
