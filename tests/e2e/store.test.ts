/**
 * Store Management E2E Tests
 * Tests critical store flows: CRUD, multi-tenancy isolation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma } from '@ebda/database';
import storeRoutes from '@api/routes/store.routes';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';
import { createSuperAdminWithMfa, loginAsSuperAdmin, mintAccessToken } from './helpers/mfa-login';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/auth/mfa', mfaRoutes);
app.use('/stores', authenticate, storeRoutes);
app.use(errorHandler);

// Test data
const superAdminUser = {
  email: `superadmin-${Date.now()}@example.com`,
  password: 'Admin123!@#',
  firstName: 'Super',
  lastName: 'Admin',
};

const storeAdminUser = {
  email: `storeadmin-${Date.now()}@example.com`,
  password: 'Store123!@#',
  firstName: 'Store',
  lastName: 'Admin',
};

let superAdminToken: string | null = null;
let storeAdminToken: string | null = null;
let createdStoreId: string | null = null;
let superAdminId: string | null = null;
let storeAdminId: string | null = null;

describe('Store Management', () => {
  beforeAll(async () => {
    // Create super admin user — MFA pre-enrolled so requireMfaEnrolled passes
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

    const storeAdminHashedPassword = await import('bcryptjs').then(bcrypt =>
      bcrypt.hash(storeAdminUser.password, 12)
    );

    const storeAdmin = await prisma.user.create({
      data: {
        email: storeAdminUser.email,
        passwordHash: storeAdminHashedPassword,
        firstName: storeAdminUser.firstName,
        lastName: storeAdminUser.lastName,
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    storeAdminId = storeAdmin.id;

    // Login super admin — completes MFA challenge automatically
    superAdminToken = await loginAsSuperAdmin(app, superAdminUser.email, superAdminUser.password);

    storeAdminToken = mintAccessToken({
      id: storeAdmin.id,
      email: storeAdminUser.email,
      role: 'store_admin',
    });
  });

  afterAll(async () => {
    // Cleanup
    if (createdStoreId) {
      await prisma.store.delete({ where: { id: createdStoreId } }).catch(() => {});
    }
    if (superAdminId) {
      await prisma.user.delete({ where: { id: superAdminId } }).catch(() => {});
    }
    if (storeAdminId) {
      await prisma.user.delete({ where: { id: storeAdminId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('POST /stores', () => {
    it('should create a store as super admin', async () => {
      if (!superAdminToken) {
        throw new Error('Super admin token not available');
      }

      const storeData = {
        name: 'Test Store E2E',
        slug: `test-store-e2e-${Date.now()}`,
        ownerId: storeAdminId,
      };

      const res = await request(app)
        .post('/stores')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(storeData);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store.name).toBe(storeData.name);
      expect(res.body.data.store.slug).toBe(storeData.slug);

      createdStoreId = res.body.data.store.id;
    });

    it('should auto-deduplicate duplicate store slug', async () => {
      if (!superAdminToken || !createdStoreId) {
        throw new Error('Prerequisites not met');
      }

      const store = await prisma.store.findUnique({ where: { id: createdStoreId } });

      const res = await request(app)
        .post('/stores')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Another Store',
          slug: store?.slug,
          ownerId: storeAdminId,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.store.slug).not.toBe(store?.slug);
      expect(res.body.data.store.slug).toContain(store?.slug?.split('-')[0] ?? '');

      await prisma.store.delete({ where: { id: res.body.data.store.id } }).catch(() => {});
    });
  });

  describe('GET /stores/:id', () => {
    it('should allow super admin to access any store', async () => {
      if (!superAdminToken || !createdStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/stores/${createdStoreId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store.id).toBe(createdStoreId);
    });

    it('should allow store owner to access their store', async () => {
      if (!storeAdminToken || !createdStoreId || !storeAdminId) {
        throw new Error('Prerequisites not met');
      }

      // The POST /stores route always assigns ownership to the AUTHENTICATED
      // caller (super_admin in this test) regardless of any ownerId in the
      // body — intentional in store.routes.ts:398 to prevent impersonation.
      // Re-assign ownership to storeAdmin directly via Prisma so
      // requireStoreAccess lets storeAdmin through.
      await prisma.store.update({
        where: { id: createdStoreId },
        data: { ownerId: storeAdminId },
      });

      const res = await request(app)
        .get(`/stores/${createdStoreId}`)
        .set('Authorization', `Bearer ${storeAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent store', async () => {
      if (!superAdminToken) {
        throw new Error('Super admin token not available');
      }

      const res = await request(app)
        .get('/stores/non-existent-id')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('PUT /stores/:id', () => {
    it('should update store name', async () => {
      if (!superAdminToken || !createdStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${createdStoreId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ name: 'Updated Store Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store.name).toBe('Updated Store Name');
    });

    it('should update store theme', async () => {
      if (!superAdminToken || !createdStoreId) {
        throw new Error('Prerequisites not met');
      }

      const theme = {
        primaryColor: '26 100% 50%',
        fontFamily: 'modern',
      };

      const res = await request(app)
        .put(`/stores/${createdStoreId}/theme`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ theme });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Multi-tenancy Isolation', () => {
    let otherStoreId: string | null = null;
    let otherUserId: string | null = null;

    beforeAll(async () => {
      // Create another store admin and store
      const hashedPassword = await import('bcryptjs').then(bcrypt =>
        bcrypt.hash('Other123!@#', 12)
      );

      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          passwordHash: hashedPassword,
          firstName: 'Other',
          lastName: 'Admin',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      });
      otherUserId = otherUser.id;

      const otherStore = await prisma.store.create({
        data: {
          name: 'Other Store',
          slug: `other-store-${Date.now()}`,
          ownerId: otherUser.id,
          status: 'active',
        },
      });
      otherStoreId = otherStore.id;
    });

    afterAll(async () => {
      if (otherStoreId) {
        await prisma.store.delete({ where: { id: otherStoreId } }).catch(() => {});
      }
      if (otherUserId) {
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
      }
    });

    it('should prevent store admin from accessing other stores', async () => {
      if (!storeAdminToken || !otherStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${otherStoreId}`)
        .set('Authorization', `Bearer ${storeAdminToken}`)
        .send({ name: 'Hacked Name' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
