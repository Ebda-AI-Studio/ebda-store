/**
 * Validation Unit Tests
 * Tests for Zod schemas and input validation
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Define test schemas (matching API schemas)
const createStoreSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  domain: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
});

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  price: z.number().positive(),
  compareAtPrice: z.number().positive().optional(),
  sku: z.string().optional(),
  inventory: z.number().int().min(0).default(0),
  status: z.enum(['active', 'draft', 'archived']).default('draft'),
  images: z.array(z.string().url()).default([]),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

describe('Store Validation Schema', () => {
  it('should accept valid store data', () => {
    const validData = {
      name: 'My Store',
      slug: 'my-store',
    };

    const result = createStoreSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should reject empty store name', () => {
    const invalidData = {
      name: '',
      slug: 'my-store',
    };

    const result = createStoreSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject store name over 100 characters', () => {
    const invalidData = {
      name: 'a'.repeat(101),
      slug: 'my-store',
    };

    const result = createStoreSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject invalid slug format', () => {
    const invalidData = {
      name: 'My Store',
      slug: 'My Store!',
    };

    const result = createStoreSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should accept slug with valid characters', () => {
    const validData = {
      name: 'My Store',
      slug: 'my-store-123',
    };

    const result = createStoreSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });
});

describe('Product Validation Schema', () => {
  it('should accept valid product data', () => {
    const validData = {
      name: 'Test Product',
      price: 29.99,
      description: 'A great product',
    };

    const result = createProductSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should reject negative price', () => {
    const invalidData = {
      name: 'Test Product',
      price: -10,
    };

    const result = createProductSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject zero price', () => {
    const invalidData = {
      name: 'Test Product',
      price: 0,
    };

    const result = createProductSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject negative inventory', () => {
    const invalidData = {
      name: 'Test Product',
      price: 10,
      inventory: -5,
    };

    const result = createProductSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should set default values', () => {
    const minimalData = {
      name: 'Test Product',
      price: 10,
    };

    const result = createProductSchema.safeParse(minimalData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('draft');
      expect(result.data.inventory).toBe(0);
      expect(result.data.images).toEqual([]);
    }
  });

  it('should validate image URLs', () => {
    const validData = {
      name: 'Test Product',
      price: 10,
      images: ['https://example.com/image.jpg'],
    };

    const result = createProductSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should reject invalid image URLs', () => {
    const invalidData = {
      name: 'Test Product',
      price: 10,
      images: ['not-a-url'],
    };

    const result = createProductSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});

describe('User Registration Schema', () => {
  it('should accept valid registration data', () => {
    const validData = {
      email: 'user@example.com',
      password: 'password123',
      firstName: 'John',
      lastName: 'Doe',
    };

    const result = registerSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should reject invalid email', () => {
    const invalidData = {
      email: 'not-an-email',
      password: 'password123',
      firstName: 'John',
      lastName: 'Doe',
    };

    const result = registerSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject short password', () => {
    const invalidData = {
      email: 'user@example.com',
      password: '12345',
      firstName: 'John',
      lastName: 'Doe',
    };

    const result = registerSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject empty first name', () => {
    const invalidData = {
      email: 'user@example.com',
      password: 'password123',
      firstName: '',
      lastName: 'Doe',
    };

    const result = registerSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});

describe('Login Schema', () => {
  it('should accept valid login data', () => {
    const validData = {
      email: 'user@example.com',
      password: 'password',
    };

    const result = loginSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should reject empty password', () => {
    const invalidData = {
      email: 'user@example.com',
      password: '',
    };

    const result = loginSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});

describe('UUID Validation', () => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('should accept valid UUID', () => {
    expect(uuidRegex.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('should reject invalid UUID', () => {
    expect(uuidRegex.test('invalid-uuid')).toBe(false);
    expect(uuidRegex.test('123')).toBe(false);
  });
});
