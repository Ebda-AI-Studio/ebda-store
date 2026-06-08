/**
 * Feature Toggle Engine — Integration Tests
 * Tests the full feature toggle API surface: admin routes and store admin routes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '@force/database';
import featureRoutes from '@api/routes/feature.routes';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { FEATURE_KEYS_ARRAY, PLAN_BASELINE } from '@force/shared';
import { createSuperAdminWithMfa, loginAsSuperAdmin } from './helpers/mfa-login';

// ==========================================
// App Setup
// Feature routes are mounted at both /admin and /stores (see routes/index.ts)
// ==========================================

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/auth/mfa', mfaRoutes);
app.use('/admin', featureRoutes);
app.use('/stores', featureRoutes);
app.use(errorHandler);

// ==========================================
// Test Users & State
// ==========================================

const superAdminUser = {
  email: `ft-superadmin-${Date.now()}@example.com`,
  password: 'Admin123!@#',
  firstName: 'Feature',
  lastName: 'Admin',
};

const storeAdminUser = {
  email: `ft-storeadmin-${Date.now()}@example.com`,
  password: 'Store123!@#',
  firstName: 'Feature',
  lastName: 'StoreOwner',
};

let superAdminToken: string | null = null;
let storeAdminToken: string | null = null;
let superAdminId: string | null = null;
let storeAdminId: string | null = null;
let storeId: string | null = null;

// ==========================================
// Suite
// ==========================================

describe('Feature Toggle Engine', () => {
  beforeAll(async () => {
    const hashedPassword = await bcrypt.hash(superAdminUser.password, 12);

    // Create super admin — MFA pre-enrolled so requireMfaEnrolled passes
    const superAdmin = await createSuperAdminWithMfa({
      email: superAdminUser.email,
      passwordHash: hashedPassword,
      firstName: superAdminUser.firstName,
      lastName: superAdminUser.lastName,
    });
    superAdminId = superAdmin.id;

    // Create store admin
    const storeAdmin = await prisma.user.create({
      data: {
        email: storeAdminUser.email,
        passwordHash: hashedPassword,
        firstName: storeAdminUser.firstName,
        lastName: storeAdminUser.lastName,
        role: 'store_admin',
        status: 'active',
      },
    });
    storeAdminId = storeAdmin.id;

    // Create a store owned by the store admin
    const store = await prisma.store.create({
      data: {
        name: 'Feature Toggle Test Store',
        slug: `ft-test-store-${Date.now()}`,
        ownerId: storeAdmin.id,
        status: 'active',
      },
    });
    storeId = store.id;

    // Login super admin — completes MFA challenge automatically
    superAdminToken = await loginAsSuperAdmin(app, superAdminUser.email, superAdminUser.password);

    // Generate store admin JWT directly (avoids login route issues in test env)
    // The authenticate middleware verifies JWT with JWT_SECRET, which is set in tests/setup.ts
    const jwtSecret = process.env.JWT_SECRET!;
    storeAdminToken = jwt.sign(
      { userId: storeAdminId!, email: storeAdminUser.email, role: 'store_admin' },
      jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: '1h',
        issuer: 'force-api',
        audience: 'force-app',
        subject: storeAdminId!,
      }
    );
  });

  afterAll(async () => {
    if (storeId) {
      await prisma.storeFeature.deleteMany({ where: { storeId } }).catch(() => {});
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    if (superAdminId) {
      await prisma.user.delete({ where: { id: superAdminId } }).catch(() => {});
    }
    if (storeAdminId) {
      await prisma.user.delete({ where: { id: storeAdminId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  // ==========================================
  // 1. Default state — new store has all features disabled
  // ==========================================

  describe('Default feature state', () => {
    it('should return all features as false for a new store (no StoreFeature rows)', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/admin/stores/${storeId}/features`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { features } = res.body.data;
      expect(features).toBeDefined();

      // Resolved-map semantics (2026-05-27): features that are in
      // PLAN_BASELINE for the store's plan return true; everything else
      // returns false. The test store uses the Prisma schema default
      // `plan = 'starter'` (NOT free — see Store model in schema.prisma),
      // so the resolved map should match PLAN_BASELINE.starter.
      const baseline = new Set(PLAN_BASELINE.starter);
      for (const key of FEATURE_KEYS_ARRAY) {
        const expected = baseline.has(key);
        expect(features[key]).toBe(expected);
      }
    });
  });

  // ==========================================
  // 2. Enable features (bulk PUT)
  // ==========================================

  describe('PUT /admin/stores/:id/features — bulk update', () => {
    it('should enable coupons and loyalty and return updated map', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/admin/stores/${storeId}/features`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ coupons: true, loyalty: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { features } = res.body.data;
      expect(features).toBeDefined();
      expect(features.coupons).toBe(true);
      expect(features.loyalty).toBe(true);
      // 2026-05-27: `reviews` is in PLAN_BASELINE.starter (default plan)
      // so it resolves to true even without an override row. Keys not in
      // starter baseline (e.g. sms — enterprise-only) remain false.
      expect(features.reviews).toBe(true);
      expect(features.sms).toBe(false);
    });
  });

  // ==========================================
  // 3. GET features — returns features, metadata, registry
  // ==========================================

  describe('GET /admin/stores/:id/features', () => {
    it('should return features map, metadata array, and registry', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/admin/stores/${storeId}/features`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { features, metadata, registry } = res.body.data;

      // features map
      expect(features).toBeDefined();
      expect(typeof features).toBe('object');

      // metadata array
      expect(Array.isArray(metadata)).toBe(true);
      // At least coupons and loyalty rows should be present
      const couponsMeta = metadata.find((m: any) => m.featureKey === 'coupons');
      expect(couponsMeta).toBeDefined();
      expect(couponsMeta.enabled).toBe(true);

      // registry
      expect(registry).toBeDefined();
      expect(registry.coupons).toBeDefined();
      expect(registry.coupons.key).toBe('coupons');
      expect(registry.coupons.name).toBe('Coupons');
    });
  });

  // ==========================================
  // 4. Single feature set (idempotent)
  // ==========================================

  describe('PUT /admin/stores/:id/features/:featureKey — single feature', () => {
    it('should set whatsapp to true idempotently', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      // First call
      const res1 = await request(app)
        .put(`/admin/stores/${storeId}/features/whatsapp`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ enabled: true });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.features.whatsapp).toBe(true);

      // Second call (idempotent — same result expected)
      const res2 = await request(app)
        .put(`/admin/stores/${storeId}/features/whatsapp`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ enabled: true });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.data.features.whatsapp).toBe(true);
    });
  });

  // ==========================================
  // 5. Zod validation — unknown key in bulk update
  // ==========================================

  describe('Validation — bulk update', () => {
    it('should return 400 when body contains an unknown feature key', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/admin/stores/${storeId}/features`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ unknown_key: true });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    // ==========================================
    // 6. Zod validation — empty body in bulk update
    // ==========================================

    it('should return 400 when body is empty ({})', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/admin/stores/${storeId}/features`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });
  });

  // ==========================================
  // 7. Feature key validation — invalid key in single update
  // ==========================================

  describe('Validation — single feature key', () => {
    it('should return 400 for an invalid feature key in the route param', async () => {
      if (!superAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/admin/stores/${storeId}/features/invalid_key`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ enabled: true });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_FEATURE_KEY');
    });
  });

  // ==========================================
  // 8. Store admin access — GET /stores/:storeId/my-features
  // ==========================================

  describe('GET /stores/:storeId/my-features — store admin access', () => {
    it('should return features map (no metadata, no registry) for store admin', async () => {
      if (!storeAdminToken || !storeId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/stores/${storeId}/my-features`)
        .set('Authorization', `Bearer ${storeAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { features } = res.body.data;
      expect(features).toBeDefined();
      expect(typeof features).toBe('object');

      // All 21 feature keys must be present
      for (const key of FEATURE_KEYS_ARRAY) {
        expect(typeof features[key]).toBe('boolean');
      }

      // metadata and registry should NOT be present in this endpoint
      expect(res.body.data.metadata).toBeUndefined();
      expect(res.body.data.registry).toBeUndefined();
    });
  });
});
