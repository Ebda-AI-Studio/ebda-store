/**
 * POST /uploads/video on the PRODUCTION (Workers) multipart path: `multer` is
 * aliased to apps/api/src/cf/stubs/multer-formdata.ts there, whose size/filter
 * errors reach `receiveVideo` differently from real multer's. The integration
 * test runs real multer; this one mounts the router with the stub.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import multer from 'multer';
import stub from '../../apps/api/src/cf/stubs/multer-formdata';

vi.mock('multer', async () => ({
  default: (await import('../../apps/api/src/cf/stubs/multer-formdata')).default,
}));
vi.mock('@api/middleware/store-access', () => ({
  checkStoreAccess: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin', storeId: 'store-1' };
    next();
  },
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  uploadLimiter: (_q: any, _s: any, n: any) => n(),
  dailyUploadLimiter: (_q: any, _s: any, n: any) => n(),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock('@api/services/image-resize.service', () => ({
  resizeToAspect: vi.fn(),
  enforceMaxDimensions: vi.fn(),
}));
const upload = vi.hoisted(() => vi.fn());
vi.mock('@api/services/storage.service', () => ({
  StorageService: { upload, uploadMultiple: vi.fn(), isAvailable: () => true },
}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.alloc(64),
]);

describe('POST /uploads/video through the Workers multer stub', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: router } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/u', router);
  });
  it('is really running on the stub', () => {
    expect(multer).toBe(stub);
  });

  const url = '/u/video?folder=hero&storeId=store-1';

  it('> 6 MB is 413', async () => {
    const r = await request(app)
      .post(url)
      .attach('file', Buffer.concat([MP4, Buffer.alloc(6 * 1024 * 1024)]), {
        filename: 'big.mp4',
        contentType: 'video/mp4',
      });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('VIDEO_TOO_LARGE');
    expect(upload).not.toHaveBeenCalled();
  });

  it('declared image/png is 400 INVALID_VIDEO_TYPE', async () => {
    const r = await request(app)
      .post(url)
      .attach('file', MP4, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_VIDEO_TYPE');
  });

  it('a second file is a 4xx, never a 500', async () => {
    const r = await request(app)
      .post(url)
      .attach('file', MP4, { filename: 'a.mp4', contentType: 'video/mp4' })
      .attach('file', MP4, { filename: 'b.mp4', contentType: 'video/mp4' });
    expect(r.status).toBeLessThan(500);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('a CHUNKED body past the cap (no Content-Length) is 413, never a 500', async () => {
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const boundary = 'b0chunked';
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: url,
            method: 'POST',
            headers: {
              'content-type': `multipart/form-data; boundary=${boundary}`,
              'transfer-encoding': 'chunked',
            },
          },
          r => {
            let body = '';
            r.on('data', c => (body += c));
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
          }
        );
        // The server may answer and close before the whole body is written.
        req.on('error', e =>
          (e as NodeJS.ErrnoException).code === 'EPIPE' ? undefined : reject(e)
        );
        req.write(
          `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="big.mp4"\r\ncontent-type: video/mp4\r\n\r\n`
        );
        req.write(MP4);
        const chunk = Buffer.alloc(256 * 1024);
        for (let i = 0; i < 28; i++) req.write(chunk); // 7 MB > 6 MB + framing
        req.end(`\r\n--${boundary}--\r\n`);
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error.code).toBe('VIDEO_TOO_LARGE');
      expect(upload).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
