/**
 * B0-46 class sweep: POST /stores/:storeId/expenses/upload-receipt stored the receipt under
 * the client's declared mime (`contentType: req.file.mimetype`) and filename, so HTML declared
 * as image/png landed in the public bucket. The bytes now decide: JPEG/PNG/WebP only, stored
 * under the extension and Content-Type of the bytes actually stored.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { uploadMock, sendMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async (_buf: Buffer, _args: { contentType: string; ext: string }) => ({
    key: 'stores/store-1/receipts/r.jpg',
  })),
  sendMock: vi.fn(async () => undefined),
}));

vi.mock('@api/services/plan-limit.service', () => ({
  assertStorageRoom: vi.fn(async () => undefined),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin', storeId: 'store-1' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  receiptReadLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: { putPrivate: uploadMock, isAvailable: vi.fn(() => true) },
}));
vi.mock('@api/services/image-resize.service', () => ({
  enforceMaxDimensions: vi.fn(async (buf: Buffer) => buf),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: sendMock } }));
vi.mock('@api/services/accounting/expense.service', () => ({}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));
// The route scopes through the backend-aware wrapper (NEON-ZERO-1 group A); a unit test has no store flag to read.
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: (_storeId: string, fn: () => unknown) => fn(),
}));

import { errorHandler } from '@api/middleware/error-handler';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

describe('expense receipt upload is judged by its bytes', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: router } = await import('@api/routes/expenses.routes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores', router);
    app.use(errorHandler);
  });
  beforeEach(() => {
    uploadMock.mockClear();
  });

  it('refuses HTML declared as image/png, before storage, bilingual', async () => {
    const res = await request(app)
      .post('/api/v1/stores/store-1/expenses/upload-receipt')
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'r.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_CONTENT');
    expect(res.body.error.details.messageAr).toMatch(/[؀-ۿ]/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('refuses a real GIF: receipts are JPEG, PNG or WebP only', async () => {
    const res = await request(app)
      .post('/api/v1/stores/store-1/expenses/upload-receipt')
      .attach('file', GIF, { filename: 'r.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_CONTENT');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('stores a JPEG declared as PNG under .jpg and image/jpeg', async () => {
    const res = await request(app)
      .post('/api/v1/stores/store-1/expenses/upload-receipt')
      .attach('file', JPEG, { filename: 'receipt.png', contentType: 'image/png' });
    expect(res.status).toBe(202);
    const call = uploadMock.mock.calls.at(-1)!;
    expect(call[1].ext).toBe('.jpg');
    expect(call[1].contentType).toBe('image/jpeg');
    // private reference, never a public URL
    expect(res.body.receiptUrl).toBe('private:stores/store-1/receipts/r.jpg');
  });

  it.each(['private:stores/store-1/instapay/proof.jpg', ' PRIVATE:stores/store-1/tax/card.pdf'])(
    'create-expense rejects a client-sent private reference (%s)',
    async ref => {
      const res = await request(app).post('/api/v1/stores/store-1/expenses').send({
        amount: 100,
        expenseAccountId: '11111111-1111-4111-8111-111111111111',
        paidFromAccountId: '22222222-2222-4222-8222-222222222222',
        expenseDate: '2026-11-01',
        receiptImageUrl: ref,
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('receiptImageUrl');
    }
  );
});

describe('the admin create form sends the field the API reads (#739 review)', () => {
  it('posts receiptImageUrl (the old `receiptUrl` key was silently dropped by the schema)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      'apps/admin/src/app/stores/[id]/finance/expenses/new/page.tsx',
      'utf8'
    );
    expect(src).toMatch(/receiptImageUrl: receiptUrl\.trim\(\) \|\| undefined/);
    expect(src).not.toMatch(/^\s*receiptUrl: receiptUrl/m);
  });
});
