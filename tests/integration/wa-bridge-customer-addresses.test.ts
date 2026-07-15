/**
 * Integration test: GET + POST /wa-bridge/customer-addresses
 *
 * Tests the two new endpoints added in Task A.3. Uses the CustomerAddressService
 * unit-tested in Task A.2. This test verifies the HTTP layer only — the service
 * logic is already covered by the unit test.
 *
 * NOTE: This is a contract test using unit-level mocks for the Prisma client
 * (no real DB needed). The endpoints are thin wrappers around the service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module before importing the service
vi.mock('@force/database', () => ({
  prisma: {
    customerAddress: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    customer: {
      findFirst: vi.fn(),
    },
  },
}));

// Mock the wa-bridge-auth middleware to passthrough in test mode
vi.mock('@api/middleware/wa-bridge-auth', () => ({
  waBridgeAuth: (req: any, _res: any, next: any) => {
    req.bridgeStore = { id: 'store-test-123', name: 'Test Store', currency: 'KWD', slug: 'test' };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { prisma } from '@force/database';
import wabridge from '@api/routes/wa-bridge.routes';

const app = express();
app.use(express.json());
app.use('/api/v1/wa-bridge', wabridge);

describe('GET /wa-bridge/customer-addresses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when customerId missing', async () => {
    const res = await request(app)
      .get('/api/v1/wa-bridge/customer-addresses')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CUSTOMER_ID_REQUIRED');
  });

  it('returns 200 + empty list when no addresses exist', async () => {
    (prisma.customerAddress.findMany as any).mockResolvedValue([]);
    const res = await request(app)
      .get('/api/v1/wa-bridge/customer-addresses?customerId=cust-abc')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.data.addresses).toEqual([]);
    // Scoped to the authenticated bridge store — never the raw customerId alone.
    expect(prisma.customerAddress.findMany).toHaveBeenCalledWith({
      where: { customerId: 'cust-abc', customer: { storeId: 'store-test-123' } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  });

  it('returns 200 + empty list for a customerId owned by another store (cross-tenant)', async () => {
    // The scoped where clause means Prisma returns [] rather than another
    // tenant's saved delivery addresses — verifying no PII leak.
    (prisma.customerAddress.findMany as any).mockResolvedValue([]);
    const res = await request(app)
      .get('/api/v1/wa-bridge/customer-addresses?customerId=cust-owned-by-other-store')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.data.addresses).toEqual([]);
    expect(prisma.customerAddress.findMany).toHaveBeenCalledWith({
      where: {
        customerId: 'cust-owned-by-other-store',
        customer: { storeId: 'store-test-123' },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  });
});

describe('POST /wa-bridge/customer-addresses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when required fields missing', async () => {
    const res = await request(app)
      .post('/api/v1/wa-bridge/customer-addresses')
      .set('X-WBS-API-KEY', 'test-key')
      .send({ customerId: 'cust-abc' }); // missing street + area
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_FIELDS');
  });

  it('returns 201 + created address with isDefault=true (first address)', async () => {
    (prisma.customer.findFirst as any).mockResolvedValue({ id: 'cust-abc' });
    (prisma.customerAddress.findMany as any).mockResolvedValue([]);
    (prisma.customerAddress.create as any).mockResolvedValue({
      id: 'addr-1',
      customerId: 'cust-abc',
      street: 'Block 3, House 14',
      area: 'Salmiya',
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post('/api/v1/wa-bridge/customer-addresses')
      .set('X-WBS-API-KEY', 'test-key')
      .send({ customerId: 'cust-abc', street: 'Block 3, House 14', area: 'Salmiya' });

    expect(res.status).toBe(201);
    expect(res.body.data.address).toMatchObject({
      street: 'Block 3, House 14',
      area: 'Salmiya',
      isDefault: true,
    });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'cust-abc', storeId: 'store-test-123' },
      select: { id: true },
    });
  });

  it('returns 404 when creating an address for a customerId owned by another store (cross-tenant)', async () => {
    (prisma.customer.findFirst as any).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/wa-bridge/customer-addresses')
      .set('X-WBS-API-KEY', 'test-key')
      .send({
        customerId: 'cust-owned-by-other-store',
        street: 'Block 3, House 14',
        area: 'Salmiya',
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CUSTOMER_NOT_FOUND');
    expect(prisma.customerAddress.create).not.toHaveBeenCalled();
  });
});
