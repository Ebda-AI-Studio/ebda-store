/**
 * API Integration Tests
 * Tests for API endpoints and their integration with services
 */

import { describe, it, expect } from 'vitest';

// API base URL for testing. Health is the public/load-balancer endpoint
// (no /api/v1 prefix). Everything else lives under /api/v1.
const API_HOST = 'http://localhost:4000';
const API_URL = `${API_HOST}/api/v1`;

// Admin credentials must match what the seed script provisioned. CI sets
// ADMIN_PASSWORD; locally we fall back to the historical value.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@forcemedia.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Test utilities
let authToken: string;
let customerToken: string;
let testStoreId: string;

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
    it('should login with valid credentials', async () => {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.accessToken).toBeDefined();
      expect(data.data.refreshToken).toBeDefined();

      authToken = data.data.accessToken;
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

    it('should register new user', async () => {
      const uniqueEmail = `test-${Date.now()}@example.com`;
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: uniqueEmail,
          password: 'testpassword123',
          firstName: 'Test',
          lastName: 'User',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.user.email).toBe(uniqueEmail);

      customerToken = data.data.accessToken;
    });

    it('should reject duplicate email registration', async () => {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@forcemedia.com',
          password: 'testpassword',
          firstName: 'Test',
          lastName: 'User',
        }),
      });
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
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

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
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
      expect(data.error.code).toBe('NOT_FOUND');
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
      const response = await fetch(`${API_URL}/health`);
      const data = await response.json();

      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      expect(data.success).toBe(true);
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
    it('should list products (public)', async () => {
      const response = await fetch(`${API_URL}/products`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data.products)).toBe(true);
    });

    it('should list categories (public)', async () => {
      const response = await fetch(`${API_URL}/categories`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });
});
