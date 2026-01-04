/**
 * Account Lockout E2E Tests
 * Tests brute force protection and account lockout behavior
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma } from '@force/database';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { accountLockout } from '@api/services/account-lockout.service';
import bcrypt from 'bcryptjs';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use(errorHandler);

// Test data
const testUser = {
  email: `lockout-test-${Date.now()}@example.com`,
  password: 'Test123!@#',
  firstName: 'Lockout',
  lastName: 'Test',
};

let createdUserId: string | null = null;

describe('Account Lockout Security', () => {
  beforeAll(async () => {
    // Create test user directly
    const hashedPassword = await bcrypt.hash(testUser.password, 12);

    const user = await prisma.user.create({
      data: {
        email: testUser.email,
        passwordHash: hashedPassword,
        firstName: testUser.firstName,
        lastName: testUser.lastName,
        role: 'customer',
        emailVerified: true,
      },
    });
    createdUserId = user.id;
  });

  afterAll(async () => {
    // Cleanup
    if (createdUserId) {
      await prisma.user.delete({ where: { id: createdUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset lockout state between tests
    await accountLockout.unlockAccount(testUser.email);
  });

  describe('Failed Login Attempts', () => {
    it('should allow login with correct credentials', async () => {
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
    });

    it('should return attempts remaining on failed login', async () => {
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      // Should show remaining attempts
      expect(res.body.error.message).toMatch(/\d+ attempts remaining/);
    });

    it('should lock account after 5 failed attempts', async () => {
      // Make 5 failed login attempts
      for (let i = 0; i < 5; i++) {
        await request(app).post('/auth/login').send({
          email: testUser.email,
          password: 'wrongpassword',
        });
      }

      // 6th attempt should be locked
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password, // Even correct password
      });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(res.body.error.message).toMatch(/locked/i);
      expect(res.body.error.message).toMatch(/\d+ minutes/);
    });

    it('should prevent login even with correct password when locked', async () => {
      // Lock the account
      for (let i = 0; i < 5; i++) {
        await request(app).post('/auth/login').send({
          email: testUser.email,
          password: 'wrongpassword',
        });
      }

      // Try with correct password
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('should reset attempts after successful login', async () => {
      // Make 2 failed attempts
      await request(app).post('/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });
      await request(app).post('/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });

      // Successful login
      const successRes = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });
      expect(successRes.status).toBe(200);

      // Verify attempts are reset by checking we can make 4 more failures without lockout
      for (let i = 0; i < 4; i++) {
        const res = await request(app).post('/auth/login').send({
          email: testUser.email,
          password: 'wrongpassword',
        });
        expect(res.status).toBe(401); // Not locked yet
      }
    });
  });

  describe('Account Unlock', () => {
    it('should allow manual account unlock', async () => {
      // Lock the account
      for (let i = 0; i < 5; i++) {
        await request(app).post('/auth/login').send({
          email: testUser.email,
          password: 'wrongpassword',
        });
      }

      // Verify locked
      const lockStatus = await accountLockout.isLocked(testUser.email);
      expect(lockStatus.locked).toBe(true);

      // Unlock
      await accountLockout.unlockAccount(testUser.email);

      // Should be able to login now
      const res = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Non-existent User Protection', () => {
    it('should not reveal if user exists on failed login', async () => {
      const existingUserRes = await request(app).post('/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });

      const nonExistentRes = await request(app).post('/auth/login').send({
        email: 'nonexistent@example.com',
        password: 'wrongpassword',
      });

      // Both should return same error code to prevent enumeration
      expect(existingUserRes.status).toBe(401);
      expect(nonExistentRes.status).toBe(401);
      expect(existingUserRes.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(nonExistentRes.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('Audit Logging', () => {
    it('should log failed login attempts', async () => {
      await request(app).post('/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });

      // Check audit log
      const log = await prisma.auditLog.findFirst({
        where: {
          action: 'LOGIN_FAILED',
          details: {
            path: ['email'],
            equals: testUser.email,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).toBeDefined();
      expect(log?.action).toBe('LOGIN_FAILED');
    });

    it('should log successful login', async () => {
      await request(app).post('/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });

      // Check audit log
      const log = await prisma.auditLog.findFirst({
        where: {
          action: 'LOGIN_SUCCESS',
          details: {
            path: ['email'],
            equals: testUser.email,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).toBeDefined();
      expect(log?.action).toBe('LOGIN_SUCCESS');
    });
  });
});
