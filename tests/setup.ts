/**
 * Vitest Global Test Setup
 * Configures the test environment before running tests
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Mock environment variables — only set when not already provided by the
// caller. CI passes a real DATABASE_URL pointing at the test postgres
// service and we must not clobber it; local unit tests use mocked prisma
// so the placeholder is fine when nothing is set.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-jwt-refresh-secret-key';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';

// Global test lifecycle hooks
beforeAll(async () => {
  // Setup code that runs once before all tests
  console.log('Starting test suite...');
});

afterAll(async () => {
  // Cleanup code that runs once after all tests
  console.log('Test suite completed.');
});

beforeEach(() => {
  // Reset mocks before each test
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.restoreAllMocks();
});

// Global test utilities
export const mockUser = {
  id: 'test-user-id-123',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  role: 'customer' as const,
  status: 'active' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const mockAdmin = {
  id: 'admin-user-id-456',
  email: 'admin@example.com',
  firstName: 'Admin',
  lastName: 'User',
  role: 'super_admin' as const,
  status: 'active' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const mockStore = {
  id: 'test-store-id-789',
  name: 'Test Store',
  slug: 'test-store',
  ownerId: 'admin-user-id-456',
  status: 'active' as const,
  plan: 'starter' as const,
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const mockProduct = {
  id: 'test-product-id-101',
  name: 'Test Product',
  slug: 'test-product',
  description: 'A test product',
  price: 29.99,
  compareAtPrice: 39.99,
  sku: 'TEST-001',
  inventory: 100,
  status: 'active' as const,
  storeId: 'test-store-id-789',
  images: ['https://example.com/image.jpg'],
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Helper to generate JWT token for testing
export function generateTestToken(user: typeof mockUser | typeof mockAdmin): string {
  // This would be replaced with actual JWT generation in real tests
  return `test-token-${user.role}-${user.id}`;
}

// Helper to create mock request
export function createMockRequest(overrides = {}) {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    user: null,
    ip: '127.0.0.1',
    ...overrides,
  };
}

// Helper to create mock response
export function createMockResponse() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

// Helper to create mock next function
export function createMockNext() {
  return vi.fn();
}
