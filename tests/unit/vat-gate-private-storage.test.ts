/**
 * Tax documents are PII (ruling TAX-4): they live ONLY in the private bucket
 * (`STORAGE_PRIVATE_BUCKET`, default `ebda-private`) and are never given a URL.
 * FAIL CLOSED: with no private bucket configured — unset-to-empty, or set equal
 * to the public bucket (which would make it public) — the upload is refused
 * with 503 PRIVATE_STORAGE_NOT_CONFIGURED and nothing is written anywhere.
 *
 * Mutation proof (recorded in the PR): making `StorageService.privateBucket()`
 * fall back to `config.storageBucket` instead of throwing turns the three
 * fail-closed cases red; pointing `putPrivate` at `config.storageBucket`
 * turns "writes only to the private bucket" red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; input: Record<string, unknown> }>,
  profileFindUnique: vi.fn(),
  docCount: vi.fn(),
  docCreate: vi.fn(),
}));

vi.mock('@api/lib/lazy-modules', () => {
  const cmd = (name: string) =>
    class {
      constructor(public input: Record<string, unknown>) {
        Object.assign(this, { __name: name });
      }
    };
  return {
    loadS3: async () => ({
      S3Client: class {
        async send(c: { __name: string; input: Record<string, unknown> }) {
          h.sent.push({ name: c.__name, input: c.input });
          return {};
        }
      },
      PutObjectCommand: cmd('Put'),
      GetObjectCommand: cmd('Get'),
      DeleteObjectCommand: cmd('Delete'),
    }),
    loadS3Presigner: async () => ({}),
  };
});
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/services/store.service', () => ({ bustStoreCachesById: vi.fn() }));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (_n: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('@ebda/database', () => ({
  Prisma: {},
  withUser: (_u: string, fn: () => Promise<unknown>) => fn(),
  prisma: {
    storeTaxProfile: { findUnique: h.profileFindUnique },
    storeTaxDocument: { count: h.docCount, create: h.docCreate },
  },
}));

const { config } = await import('@api/config');
const { StorageService } = await import('@api/services/storage.service');
const { TaxProfileService } = await import('@api/services/tax-profile.service');

const PDF = Buffer.from('%PDF-1.7\n...');
const upload = () =>
  TaxProfileService.addDocument(
    '11111111-1111-4111-8111-111111111111',
    'tax_card',
    { buffer: PDF, originalname: 'card.pdf' },
    { userId: 'u-1' }
  );

beforeEach(() => {
  h.sent.length = 0;
  Object.assign(config, {
    storageEndpoint: 'https://r2.example',
    storageAccessKey: 'ak',
    storageSecretKey: 'sk',
    storageBucket: 'ebda-media',
    storagePrivateBucket: 'ebda-private',
  });
  h.profileFindUnique.mockResolvedValue({ id: 'p1', status: 'none' });
  h.docCount.mockResolvedValue(0);
  h.docCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'd1',
    kind: data.kind,
    fileName: data.fileName,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    createdAt: new Date(),
  }));
});

describe('tax documents go to the PRIVATE bucket only', () => {
  it('writes only to the private bucket, under the store prefix, with no URL stored', async () => {
    const doc = await upload();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].name).toBe('Put');
    expect(h.sent[0].input.Bucket).toBe('ebda-private');
    expect(String(h.sent[0].input.Key)).toMatch(
      /^stores\/11111111-1111-4111-8111-111111111111\/tax-documents\/[0-9a-f-]{36}\.pdf$/
    );
    expect(h.sent[0].input.CacheControl).toBe('private, no-store');
    const data = h.docCreate.mock.calls[0][0].data;
    expect(data.storageKey).toBe(h.sent[0].input.Key);
    expect(JSON.stringify(data)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(doc)).not.toMatch(/stores\/|https?:/);
  });

  it('a failed DB write removes the object it just stored (no private orphan)', async () => {
    h.docCreate.mockRejectedValueOnce(new Error('db down'));
    await expect(upload()).rejects.toThrow('db down');
    expect(h.sent.map(c => c.name)).toEqual(['Put', 'Delete']);
    expect(h.sent[1].input).toMatchObject({ Bucket: 'ebda-private', Key: h.sent[0].input.Key });
  });
});

describe('fail closed: no private bucket → refuse, write nothing', () => {
  it.each([
    ['STORAGE_PRIVATE_BUCKET set to empty', { storagePrivateBucket: '' }],
    ['private bucket equals the public bucket', { storagePrivateBucket: 'ebda-media' }],
    ['no storage credentials', { storageAccessKey: '' }],
  ])('%s → 503 PRIVATE_STORAGE_NOT_CONFIGURED', async (_label, patch) => {
    Object.assign(config, patch);
    const err = await upload().catch(e => e);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('PRIVATE_STORAGE_NOT_CONFIGURED');
    expect(h.sent).toHaveLength(0);
    expect(h.docCreate).not.toHaveBeenCalled();
  });

  it('reading a document also refuses without a private bucket (never tries the public one)', async () => {
    Object.assign(config, { storagePrivateBucket: '' });
    await expect(StorageService.getPrivate('stores/x/tax-documents/y.pdf')).rejects.toMatchObject({
      code: 'PRIVATE_STORAGE_NOT_CONFIGURED',
    });
    expect(h.sent).toHaveLength(0);
  });

  it('the public upload path no longer accepts the tax-documents folder', async () => {
    const err = await StorageService.upload(PDF, 'card.pdf', {
      folder: 'tax-documents',
      storeId: '11111111-1111-4111-8111-111111111111',
      contentType: 'application/pdf',
      allowedTypes: ['application/pdf'],
    }).catch(e => e);
    expect(err.code).toBe('INVALID_FOLDER');
    expect(h.sent).toHaveLength(0);
  });
});
