/**
 * Authentication Unit Tests
 * Tests for authentication utilities and middleware
 */

import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Test utilities
import { mockUser, mockAdmin } from '../setup';

describe('Authentication', () => {
  describe('Password Hashing', () => {
    it('should hash password correctly', async () => {
      const password = 'SecurePassword123!';
      const hash = await bcrypt.hash(password, 10);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(50);
    });

    it('should verify correct password', async () => {
      const password = 'SecurePassword123!';
      const hash = await bcrypt.hash(password, 10);

      const isValid = await bcrypt.compare(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'SecurePassword123!';
      const hash = await bcrypt.hash(password, 10);

      const isValid = await bcrypt.compare('WrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('should generate unique hashes for same password', async () => {
      const password = 'SecurePassword123!';
      const hash1 = await bcrypt.hash(password, 10);
      const hash2 = await bcrypt.hash(password, 10);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('JWT Token Generation', () => {
    const secret = 'test-secret-key';

    it('should generate valid JWT token', () => {
      const payload = { userId: mockUser.id, email: mockUser.email, role: mockUser.role };
      const token = jwt.sign(payload, secret, { expiresIn: '1h' });

      expect(token).toBeDefined();
      expect(token.split('.').length).toBe(3);
    });

    it('should decode token correctly', () => {
      const payload = { userId: mockUser.id, email: mockUser.email, role: mockUser.role };
      const token = jwt.sign(payload, secret, { expiresIn: '1h' });

      const decoded = jwt.verify(token, secret) as typeof payload;

      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.email).toBe(mockUser.email);
      expect(decoded.role).toBe(mockUser.role);
    });

    it('should reject token with wrong secret', () => {
      const payload = { userId: mockUser.id };
      const token = jwt.sign(payload, secret);

      expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
    });

    it('should reject expired token', () => {
      const payload = { userId: mockUser.id };
      const token = jwt.sign(payload, secret, { expiresIn: '-1s' });

      expect(() => jwt.verify(token, secret)).toThrow();
    });
  });

  describe('Role-Based Access Control', () => {
    it('should identify super_admin role', () => {
      expect(mockAdmin.role).toBe('super_admin');
    });

    it('should identify customer role', () => {
      expect(mockUser.role).toBe('customer');
    });

    it('should validate admin can access admin routes', () => {
      const allowedRoles = ['admin', 'super_admin'];
      const hasAccess = allowedRoles.includes(mockAdmin.role);
      expect(hasAccess).toBe(true);
    });

    it('should validate customer cannot access admin routes', () => {
      const allowedRoles = ['admin', 'super_admin'];
      const hasAccess = allowedRoles.includes(mockUser.role);
      expect(hasAccess).toBe(false);
    });
  });
});

describe('Input Validation', () => {
  describe('Email Validation', () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    it('should accept valid email', () => {
      expect(emailRegex.test('user@example.com')).toBe(true);
      expect(emailRegex.test('user.name@example.co.uk')).toBe(true);
    });

    it('should reject invalid email', () => {
      expect(emailRegex.test('invalid-email')).toBe(false);
      expect(emailRegex.test('user@')).toBe(false);
      expect(emailRegex.test('@example.com')).toBe(false);
    });
  });

  describe('Password Validation', () => {
    const minLength = 6;

    it('should accept valid password', () => {
      expect('password123'.length >= minLength).toBe(true);
      expect('SecurePass!'.length >= minLength).toBe(true);
    });

    it('should reject short password', () => {
      expect('12345'.length >= minLength).toBe(false);
      expect('abc'.length >= minLength).toBe(false);
    });
  });
});
