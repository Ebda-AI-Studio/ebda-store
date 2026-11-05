/**
 * Ruling NZ-SF-5 (security review): the address book's store is the verified token's store, never the raw X-Store-ID header.
 * A customer of store A sending B, a duplicate / array header, or a malformed one never reaches B's Durable Object; a merchant
 * token ignores the header and keeps the Postgres address book.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  user: { userId: 'u1', role: 'customer', storeId: '' } as Record<string, unknown>,
  storeWriter: vi.fn(),
  userStores: [] as Array<string | null | undefined>,
  pg: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    address: { findMany: (...a: unknown[]) => (h.pg as (...x: unknown[]) => unknown)(...a) },
  },
}));
vi.mock('@api/lib/repo-factory', () => ({ storeWriter: (id: string) => h.storeWriter(id) }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = h.user;
    next();
  },
}));
vi.mock('@api/middleware/tenant-context', () => ({
  userContext:
    (_u: unknown, getStore: (r: unknown) => string | undefined) =>
    (req: unknown, _res: unknown, next: () => void) => {
      h.userStores.push(getStore(req));
      next();
    },
}));

import addressRoutes from '@api/routes/address.routes';
import { errorHandler } from '@api/middleware/error-handler';

const app = express();
app.use(express.json());
app.use('/addresses', addressRoutes);
app.use(errorHandler);

beforeEach(() => {
  h.user = { userId: 'u1', role: 'customer', storeId: A };
  h.userStores = [];
  h.pg.mockClear();
  h.storeWriter.mockReset().mockResolvedValue({ address: { findMany: async () => [] } });
});

describe('/addresses store binding', () => {
  it('a customer uses the token store, with or without the matching header', async () => {
    expect((await request(app).get('/addresses')).status).toBe(200);
    expect((await request(app).get('/addresses').set('x-store-id', A.toUpperCase())).status).toBe(
      200
    );
    expect(h.storeWriter.mock.calls.every(c => c[0] === A)).toBe(true);
    expect(h.userStores.every(s => s === A)).toBe(true);
  });

  it('a customer of store A sending store B is 403 and B is never touched', async () => {
    const res = await request(app).get('/addresses').set('x-store-id', B);
    expect(res.status).toBe(403);
    expect(h.storeWriter).not.toHaveBeenCalled();
    expect(h.userStores).toEqual([]);
  });

  it('a duplicate header (joined with a comma), a malformed one and an empty one are 400, never trusted', async () => {
    for (const v of [`${A}, ${B}`, `${B}, ${A}`, 'not-a-uuid', '']) {
      const res = await request(app).get('/addresses').set('x-store-id', v);
      expect(res.status, v).toBe(400);
    }
    expect(h.storeWriter).not.toHaveBeenCalled();
  });

  it('a customer token with no store is 400 STORE_REQUIRED', async () => {
    h.user = { userId: 'u1', role: 'customer' };
    const res = await request(app).get('/addresses');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STORE_REQUIRED');
  });

  it('Ruling NZ-INTEG-ADDR-1: a merchant / staff / super_admin token has no address book: 400, nothing touched', async () => {
    for (const role of ['store_admin', 'staff', 'super_admin']) {
      h.user = { userId: 'm1', role };
      for (const call of [
        request(app).get('/addresses').set('x-store-id', B),
        request(app).post('/addresses').send({}),
        request(app).put(`/addresses/${A}`).send({}),
        request(app).delete(`/addresses/${A}`),
      ]) {
        const res = await call;
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('ADDRESS_BOOK_CUSTOMER_ONLY');
      }
    }
    expect(h.storeWriter).not.toHaveBeenCalled();
    expect(h.pg).not.toHaveBeenCalled();
  });
});
