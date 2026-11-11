/**
 * B0 Task 7: POST /uploads/video against the real router, real auth
 * (`authenticate` + `requirePermission`), real store-ownership check and a
 * real Postgres. Only R2 (`StorageService.upload`) is stubbed, as in
 * tests/unit/upload-routes.test.ts: the put is captured so the test can also
 * assert what would have reached R2 (content type, cache-control, key ext).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { seedBundleStore, storeAdminAccessTokenFor, hasDb } from '../helpers/bundle-fixtures';

const { putMock } = vi.hoisted(() => ({
  putMock: vi.fn(
    async (
      buffer: Buffer,
      name: string,
      opts: { folder: string; storeId: string; contentType: string }
    ) => ({
      key: `stores/${opts.storeId}/${opts.folder}/uuid-${name}`,
      url: `https://media.test/stores/${opts.storeId}/${opts.folder}/uuid-${name}`,
      size: buffer.length,
      contentType: opts.contentType,
    })
  ),
}));

vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    upload: putMock,
    uploadMultiple: vi.fn(),
    isAvailable: () => true,
    listStoreSizes: async () => ({ sizes: [], nextCursor: null }),
  },
}));
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/middleware/security')>()),
  uploadLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
  dailyUploadLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
  auditLog: vi.fn(async () => undefined),
}));

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.alloc(64),
]);
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x84]),
  Buffer.from('webm', 'latin1'),
  Buffer.alloc(64),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

describe.skipIf(!hasDb)('POST /uploads/video', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let storeId: string;
  let token: string;
  let otherStoreId: string;

  beforeAll(async () => {
    const { default: uploadRouter } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/api/v1/uploads', uploadRouter);
    const mine = await seedBundleStore(`vid-a-${suffix}`);
    const other = await seedBundleStore(`vid-b-${suffix}`);
    storeId = mine.storeId;
    otherStoreId = other.storeId;
    token = storeAdminAccessTokenFor(mine.ownerId);
  });

  const post = (
    body: Buffer,
    filename: string,
    type: string,
    q: { folder?: string; storeId?: string } = {},
    auth: string | null = token
  ) => {
    const params = new URLSearchParams({
      folder: q.folder ?? 'hero',
      storeId: q.storeId ?? storeId,
    });
    const r = request(app).post(`/api/v1/uploads/video?${params}`);
    if (auth) r.set('Authorization', `Bearer ${auth}`);
    return r.attach('file', body, { filename, contentType: type });
  };

  it('accepts a small mp4 and returns an r2 url', async () => {
    putMock.mockClear();
    const r = await post(MP4, 'clip.mp4', 'video/mp4');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.url).toMatch(/\.mp4$/);
    const [, name, opts] = putMock.mock.calls[0] as unknown as [
      Buffer,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('clip.mp4');
    expect(opts).toMatchObject({
      folder: 'hero',
      storeId,
      contentType: 'video/mp4',
      allowedTypes: ['video/mp4', 'video/webm'],
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('accepts a webm into the builder folder', async () => {
    const r = await post(WEBM, 'loop.webm', 'video/webm', { folder: 'builder' });
    expect(r.status).toBe(200);
    expect(r.body.data.url).toMatch(/\.webm$/);
  });

  it('stores under the sniffed extension, not the client filename extension', async () => {
    const r = await post(MP4, 'sneaky.png', 'video/mp4');
    expect(r.status).toBe(200);
    expect(r.body.data.url).toMatch(/sneaky\.mp4$/);
  });

  it('rejects an mp4-declared PNG with 400 and never reaches R2', async () => {
    putMock.mockClear();
    const r = await post(PNG, 'clip.mp4', 'video/mp4');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_VIDEO_CONTENT');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('rejects declared/sniffed disagreement (webm bytes declared mp4)', async () => {
    const r = await post(WEBM, 'clip.mp4', 'video/mp4');
    expect(r.status).toBe(400);
  });

  it('rejects a non-video mime with 400', async () => {
    const r = await post(PNG, 'a.png', 'image/png');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_VIDEO_TYPE');
  });

  it('rejects an empty file with 400', async () => {
    const r = await post(Buffer.alloc(0), 'empty.mp4', 'video/mp4');
    expect(r.status).toBe(400);
  });

  it('rejects > 6 MB with 413', async () => {
    putMock.mockClear();
    const big = Buffer.concat([MP4, Buffer.alloc(6 * 1024 * 1024)]);
    const r = await post(big, 'big.mp4', 'video/mp4');
    expect(r.status).toBe(413);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('rejects folder=logos with 400', async () => {
    const r = await post(MP4, 'clip.mp4', 'video/mp4', { folder: 'logos' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_FOLDER');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const r = await post(MP4, 'clip.mp4', 'video/mp4', {}, null);
    expect(r.status).toBe(401);
  });

  it("rejects another store's storeId with 403", async () => {
    putMock.mockClear();
    const r = await post(MP4, 'clip.mp4', 'video/mp4', { storeId: otherStoreId });
    expect(r.status).toBe(403);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('the image route still refuses video', async () => {
    putMock.mockClear();
    const r = await request(app)
      .post(`/api/v1/uploads/image?folder=hero&storeId=${storeId}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(r.status).not.toBe(200);
    expect(putMock).not.toHaveBeenCalled();
  });
});
