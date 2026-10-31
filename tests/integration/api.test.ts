/**
 * API Integration Tests
 * Tests for API endpoints and their integration with services
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { API_BASE, API_ORIGIN } from '../helpers/api-base';
import { identityTokenForEmail } from '../helpers/identity-session';

// Health is the public/load-balancer endpoint (no /api/v1 prefix); everything
// else lives under /api/v1. Both forms come from one validated knob — see
// tests/helpers/api-base.ts for why it is TEST_API_URL and not the server's
// own API_URL (which points at production in a deployed environment).
const API_HOST = API_ORIGIN;
const API_URL = API_BASE;

// Admin credentials must match what the seed script provisioned. CI sets
// ADMIN_PASSWORD; locally we fall back to the historical value.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@ebda.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Test utilities
let authToken: string;
let customerToken: string;
let testStoreId: string;

// Create a verified customer directly in DB and log them in to obtain a
// token. We bypass /auth/register because registration now always returns
// { emailVerificationSent: true } (email-verification gate is correct prod
// behavior). Tests that need a customer token must not rely on register
// issuing tokens.
const CUSTOMER_TEST_EMAIL = `customer-${Date.now()}@example.test`;
const CUSTOMER_TEST_PASSWORD = 'CustomerTest!1';

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(CUSTOMER_TEST_PASSWORD, 10);
  await prisma.user.create({
    data: {
      email: CUSTOMER_TEST_EMAIL,
      passwordHash,
      firstName: 'Customer',
      lastName: 'Test',
      role: 'customer',
      emailVerified: true, // bypass email-verification gate so login issues tokens
    },
  });

  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CUSTOMER_TEST_EMAIL, password: CUSTOMER_TEST_PASSWORD }),
  });
  const json = await res.json();
  customerToken = json.data?.accessToken as string;
});

describe('API Integration Tests', () => {
  describe('Health Check', () => {
    it('should return healthy status', async () => {
      // /health is the public load-balancer health endpoint; the protected
      // /api/v1/health requires super_admin auth (it's a deep dependency
      // status check) so we use the cheap public one here.
      const response = await fetch(`${API_HOST}/health`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
    });
  });

  describe('Authentication Endpoints', () => {
    it('closes the Store password login for the platform admin (it signs in at the identity service)', async () => {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('USE_IDENTITY_SERVICE');
    });

    it('accepts the identity-service token of the platform admin', async () => {
      authToken = await identityTokenForEmail(ADMIN_EMAIL);
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(response.status).toBe(200);
    });

    it('should reject invalid credentials', async () => {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ADMIN_EMAIL,
          password: 'wrongpassword',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should register new user and return email verification response', async () => {
      // Registration now triggers email verification and returns
      // { emailVerificationSent: true } — no tokens are issued until the
      // user verifies their email. This is correct prod behavior; tests
      // that need a customerToken must create verified users directly (see
      // beforeAll above).
      const uniqueEmail = `test-${Date.now()}@example.com`;
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: uniqueEmail,
          password: 'TestUser!1',
          firstName: 'Test',
          lastName: 'User',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.emailVerificationSent).toBe(true);
    });

    it('should silently accept duplicate email registration (enumeration protection)', async () => {
      // The API returns 200 + { emailVerificationSent: true } for duplicate
      // registrations to prevent user-enumeration attacks — no 409 is exposed.
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ADMIN_EMAIL,
          password: 'TestPassword1!',
          firstName: 'Test',
          lastName: 'User',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.emailVerificationSent).toBe(true);
    });
  });

  describe('Authorization & RBAC', () => {
    it('should block unauthenticated access to protected routes', async () => {
      const response = await fetch(`${API_URL}/stores`);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('should block customer from creating stores', async () => {
      const response = await fetch(`${API_URL}/stores`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({
          name: 'Unauthorized Store',
          slug: 'unauthorized-store',
        }),
      });
      const data = await response.json();

      // Ruling S11-1 (#75): a customer token works only for the store it was issued for, from
      // that store's origin; anywhere else it is a dead token (401), the same as FU46-9's
      // onboarding case.
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('TOKEN_INVALID');
    });

    it('should allow admin to access stores', async () => {
      const response = await fetch(`${API_URL}/stores`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('Store CRUD Operations', () => {
    it('should create a new store (admin)', async () => {
      const response = await fetch(`${API_URL}/stores`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: `Test Store ${Date.now()}`,
          slug: `test-store-${Date.now()}`,
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.store.id).toBeDefined();

      testStoreId = data.data.store.id;
    });

    it('should get store by ID', async () => {
      const response = await fetch(`${API_URL}/stores/${testStoreId}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.store.id).toBe(testStoreId);
    });

    it('should update store', async () => {
      const response = await fetch(`${API_URL}/stores/${testStoreId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: 'Updated Store Name',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.store.name).toBe('Updated Store Name');
    });

    it('should return 404 for non-existent store', async () => {
      const response = await fetch(`${API_URL}/stores/00000000-0000-0000-0000-000000000000`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('STORE_NOT_FOUND');
    });
  });

  describe('Input Validation', () => {
    it('should reject invalid store name (too long)', async () => {
      const response = await fetch(`${API_URL}/stores`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: 'a'.repeat(101),
          slug: 'test-slug',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid email format', async () => {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'not-an-email',
          password: 'testpassword',
          firstName: 'Test',
          lastName: 'User',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it('should handle malformed JSON', async () => {
      const response = await fetch(`${API_URL}/stores`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: '{invalid json}',
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });
  });

  describe('API Response Format', () => {
    it('should return consistent success response format', async () => {
      // /api/v1/health is a protected super_admin route. Use the public
      // load-balancer /health endpoint instead to verify the server is up.
      const response = await fetch(`${API_HOST}/health`);
      const data = await response.json();

      expect(data).toHaveProperty('status');
      expect(data.status).toBe('ok');
    });

    it('should return consistent error response format', async () => {
      const response = await fetch(`${API_URL}/stores`);
      const data = await response.json();

      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('error');
      expect(data.success).toBe(false);
      expect(data.error).toHaveProperty('code');
      expect(data.error).toHaveProperty('message');
    });

    it('should return correct content-type header', async () => {
      const response = await fetch(`${API_URL}/health`);

      expect(response.headers.get('content-type')).toContain('application/json');
    });
  });

  describe('Products Endpoint', () => {
    it('should list products for a store (authenticated)', async () => {
      // Bare /products and /categories routes don't exist. Products and
      // categories are scoped to stores. Use the store created earlier.
      const response = await fetch(`${API_URL}/stores/${testStoreId}/products`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should list categories for a store (authenticated)', async () => {
      const response = await fetch(`${API_URL}/stores/${testStoreId}/categories`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });
});
