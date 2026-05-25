/**
 * Authentication E2E Tests
 * Tests critical auth flows: login, register, token refresh
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma } from '@force/database';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use(errorHandler);

// Test data
const testUser = {
  email: `test-${Date.now()}@example.com`,
  password: 'Test123!@#',
  firstName: 'Test',
  lastName: 'User',
};

let createdUserId: string | null = null;
let authToken: string | null = null;
let refreshToken: string | null = null;

describe('Authentication Flow', () => {
  beforeAll(async () => {
    // Delete refresh tokens for test users first to avoid FK constraint
    await prisma.refreshToken.deleteMany({
      where: { user: { email: { startsWith: 'test-' } } },
    });
    // Clean up any existing test users
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'test-' } },
    });
  });

  afterAll(async () => {
    // Cleanup
    if (createdUserId) {
      await prisma.refreshToken.deleteMany({ where: { userId: createdUserId } }).catch(() => {});
      await prisma.user.delete({ where: { id: createdUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const res = await request(app).post('/auth/register').send(testUser);

      // Post T1-4 enumeration hardening: register always returns 200 with
      // { emailVerificationSent: true } regardless of whether the email
      // exists, to prevent timing-based email enumeration attacks.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.emailVerificationSent).toBe(true);
    });

    it('should silently accept duplicate email registration (enumeration protection)', async () => {
      // Post T1-4: duplicate email returns the same 200 + emailVerificationSent
      // shape as a new registration. A "registration attempt" notice is sent
      // to the rightful owner's inbox instead of leaking a 409.
      const res = await request(app).post('/auth/register').send(testUser);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.emailVerificationSent).toBe(true);
    });

    it('should validate email format', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          ...testUser,
          email: 'invalid-email',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should require password minimum length', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          ...testUser,
          email: 'another@example.com',
          password: '123',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /auth/login', () => {
    beforeAll(async () => {
      // Registration created the user but with emailVerified=false.
      // Manually verify so login tests can obtain tokens.
      const user = await prisma.user.findFirst({ where: { email: testUser.email } });
      if (user) {
        await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        createdUserId = user.id;
      }
    });

    it('should login with valid credentials', async () => {
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe(testUser.email);

      authToken = res.body.data.accessToken;
      refreshToken = res.body.data.refreshToken;
    });

    it('should reject invalid password', async () => {
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject non-existent user', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'nonexistent@example.com',
        password: 'anypassword',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh tokens with valid refresh token', async () => {
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const res = await request(app).post('/auth/refresh').send({
        refreshToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });

    it('should reject invalid refresh token', async () => {
      const res = await request(app).post('/auth/refresh').send({
        refreshToken: 'invalid-token',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /auth/me', () => {
    it('should return current user with valid token', async () => {
      if (!authToken) {
        throw new Error('No auth token available');
      }

      const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(testUser.email);
    });

    it('should reject request without token', async () => {
      const res = await request(app).get('/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject request with invalid token', async () => {
      const res = await request(app).get('/auth/me').set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
