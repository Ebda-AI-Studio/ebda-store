/**
 * PATCH /stores/:storeId/suppliers/:id — clear-on-empty against real Postgres.
 *
 * The admin supplier form sends `null` for an emptied optional text field on
 * edit (`textFieldValue(x, 'update')`, issue 1576). The route's update schema
 * was `createSchema.partial()`, which rejects null, so every edit of a supplier
 * with a blank Arabic name / contact / notes 422'd. This drives the real route,
 * Zod schema, service and Prisma write, then reads the row back: a unit test
 * with a mocked Prisma cannot prove the column actually cleared.
 *
 * Auth/feature middleware is stubbed (same pattern as
 * stock-adjustment-csv-import.test.ts); everything below it runs for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';

vi.mock('../../../apps/api/src/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: undefined, role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('../../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../apps/api/src/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('../../../apps/api/src/middleware/security', () => ({
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));

import suppliersRoutes from '../../../apps/api/src/routes/suppliers.routes';
import { createSupplier } from '../../../apps/api/src/services/accounting/supplier.service';

const OWNER_ID = '00000000-0000-0000-0000-000000001576';
let storeId: string;

const app = express();
app.use(express.json());
app.use('/stores', suppliersRoutes);
app.use((err: any, _req: any, res: any, _next: any) => {
  res.status(err?.statusCode ?? 500).json({ error: err?.code ?? 'error' });
});

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: `sup-clear-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Sup',
      lastName: 'Clear',
    },
  });
  const slug = `sup-clear-${randomUUID().slice(0, 8)}`;
  const store = await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } });
  storeId = store.id;
});

afterAll(async () => {
  await prisma.supplier.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

const FILLED = {
  nameAr: 'المطلق للتجارة',
  contactName: 'Fahad',
  phone: '+96550000000',
  email: 'sales@almutlaq.example',
  notes: 'Delivers Sundays',
  notesAr: 'يوصل الأحد',
} as const;
const CLEARABLE = Object.keys(FILLED) as (keyof typeof FILLED)[];

describe('PATCH supplier — an emptied optional field clears the column (issue 1576)', () => {
  it("the edit form's payload with every optional field emptied → 200 and every column NULL", async () => {
    const s = await createSupplier({ storeId, name: 'Al-Mutlaq Trading', ...FILLED });

    const res = await request(app).patch(`/stores/${storeId}/suppliers/${s.id}`).send({
      name: 'Al-Mutlaq Trading',
      nameAr: null,
      contactName: null,
      phone: null,
      email: null,
      paymentTerms: 'net30',
      leadTimeDays: 14,
      notes: null,
      notesAr: null,
    });

    expect(res.status).toBe(200);
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } });
    for (const f of CLEARABLE) expect(row[f], f).toBeNull();
    expect(row.leadTimeDays).toBe(14);
    expect(row.name).toBe('Al-Mutlaq Trading');
  });

  it('an omitted key leaves the stored value untouched', async () => {
    const s = await createSupplier({ storeId, name: 'Keep Me', ...FILLED });

    const res = await request(app)
      .patch(`/stores/${storeId}/suppliers/${s.id}`)
      .send({ notes: null });

    expect(res.status).toBe(200);
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.notes).toBeNull();
    expect(row.nameAr).toBe(FILLED.nameAr);
    expect(row.email).toBe(FILLED.email);
  });

  it('null on the required name is still rejected and writes nothing', async () => {
    const s = await createSupplier({ storeId, name: 'Required Name', ...FILLED });

    const res = await request(app)
      .patch(`/stores/${storeId}/suppliers/${s.id}`)
      .send({ name: null, notes: null });

    expect(res.status).toBe(422);
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.name).toBe('Required Name');
    expect(row.notes).toBe(FILLED.notes);
  });
});
