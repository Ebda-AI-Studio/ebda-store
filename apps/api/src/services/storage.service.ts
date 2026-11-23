import { VARIANT_WIDTHS, variantKey, canHaveVariants, isVariantKey } from '@ebda/shared';
import type { S3Client } from '@aws-sdk/client-s3';
import { loadS3, loadS3Presigner } from '../lib/lazy-modules';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { isBarcodeObjectKey } from '../lib/barcode-png/key';

// ==========================================
// Storage Service
// S3-compatible file storage (works with AWS S3, MinIO, R2, etc.)
// ==========================================

export interface UploadOptions {
  folder?: string;
  filename?: string;
  contentType?: string;
  maxSize?: number; // in bytes
  allowedTypes?: string[];
  /** Overrides the default 1-year `Cache-Control` (e.g. add `immutable` for uuid-keyed video). */
  cacheControl?: string;
  /**
   * Optional tenant scope. When set together with a whitelisted `folder`,
   * the resulting R2 key is namespaced as `stores/<storeId>/<folder>/...`.
   * When omitted (e.g. platform/super_admin uploads), the legacy flat key
   * shape is preserved so platform assets aren't accidentally tenant-scoped.
   */
  storeId?: string | null;
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
}

// Allowed image types
const DEFAULT_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Max file size: 10MB
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

/**
 * Per-store folders allowed under the `stores/<storeId>/...` namespace.
 * Anything not on this list is rejected with INVALID_FOLDER (400).
 *
 * - logos       → store + brand logos
 * - products    → product + variant images
 * - categories  → category covers
 * - pages       → CMS page covers
 * - branding    → theme assets
 * - hero        → homepage hero slides
 * - misc        → fallback when no folder hint is supplied
 */
const ALLOWED_TENANT_FOLDERS = new Set<string>([
  'logos',
  'products',
  'categories',
  'pages',
  'branding',
  'hero',
  // Visual builder media picker uploads: stores/<storeId>/builder/...
  'builder',
  'misc',
  // Per-store custom fonts uploaded via the typography admin page.
  // Uses the same key shape as everything else: stores/<storeId>/fonts/...
  'fonts',
  // Per-store PWA icon set (source upload + generated sizes), B5:
  // stores/<storeId>/pwa/... — see PWAService.generatePwaIconSet.
  'pwa',
  // Product 3D models (.glb / .usdz), stores/<storeId>/models/... — written
  // only by routes/product-model.routes.ts after validateGlb/validateUsdz.
  'models',
]);

/**
 * Sanitize a user-supplied filename so it can safely become part of an
 * R2 object key. Strips path separators, collapses whitespace, drops
 * anything outside [A-Za-z0-9._-], and caps length.
 */
function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/\s+/g, '-');
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '').replace(/-+/g, '-');
  // Cap to keep keys readable; uuid prefix already disambiguates collisions.
  return safe.slice(0, 64) || 'file';
}

export class StorageService {
  private static client: S3Client | null = null;

  /**
   * Get S3 client (lazy initialization)
   */
  private static async getClient(): Promise<S3Client> {
    if (!this.client) {
      if (!config.storageEndpoint || !config.storageAccessKey || !config.storageSecretKey) {
        throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Storage service is not configured');
      }

      const { S3Client } = await loadS3(); // first use, not boot (SP4 Stage 2)
      this.client = new S3Client({
        endpoint: config.storageEndpoint,
        region: 'auto',
        credentials: {
          accessKeyId: config.storageAccessKey,
          secretAccessKey: config.storageSecretKey,
        },
        forcePathStyle: true, // Required for MinIO
      });
    }
    return this.client;
  }

  /**
   * Check if storage is available
   */
  static isAvailable(): boolean {
    return !!(config.storageEndpoint && config.storageAccessKey && config.storageSecretKey);
  }

  /**
   * Upload a file from buffer
   */
  static async upload(
    buffer: Buffer,
    originalFilename: string,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    const {
      folder = 'uploads',
      filename,
      contentType,
      maxSize = DEFAULT_MAX_SIZE,
      allowedTypes = DEFAULT_ALLOWED_TYPES,
      cacheControl = 'public, max-age=31536000', // 1 year cache
      storeId,
    } = options;

    // Determine content type
    const mimeType = contentType || this.getMimeType(originalFilename);

    // Validate file type
    if (!allowedTypes.includes(mimeType)) {
      throw new AppError(
        400,
        'INVALID_FILE_TYPE',
        `File type not allowed. Allowed types: ${allowedTypes.join(', ')}`
      );
    }

    // Validate file size
    if (buffer.length > maxSize) {
      throw new AppError(
        400,
        'FILE_TOO_LARGE',
        `File size exceeds maximum of ${Math.round(maxSize / 1024 / 1024)}MB`
      );
    }

    // Generate unique filename and resolve the final R2 key.
    const ext = path.extname(originalFilename).toLowerCase();
    const key = this.composeKey({
      folder,
      storeId: storeId ?? null,
      filename,
      originalFilename,
      ext,
    });

    const client = await this.getClient();

    await client.send(
      new (await loadS3()).PutObjectCommand({
        Bucket: config.storageBucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        CacheControl: cacheControl,
      })
    );

    return {
      key,
      url: this.getPublicUrl(key),
      size: buffer.length,
      contentType: mimeType,
    };
  }

  /**
   * Write a DERIVED object (one the API renders itself, e.g. the email barcode
   * PNG) at a caller-computed deterministic key. Only keys of the exact shape
   * `stores/<storeId>/barcodes/<32 hex>.png` are accepted; it has no DB column,
   * so it is registered as derived in lib/r2-references.ts (never an orphan,
   * expires by age).
   */
  static async putDerived(key: string, body: Uint8Array, contentType: string): Promise<void> {
    if (!isBarcodeObjectKey(key)) {
      throw new AppError(400, 'INVALID_DERIVED_KEY', 'Not a derived object key');
    }
    const client = await this.getClient();
    await client.send(
      new (await loadS3()).PutObjectCommand({
        Bucket: config.storageBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
  }

  /**
   * Upload multiple files
   */
  static async uploadMultiple(
    files: Array<{ buffer: Buffer; filename: string }>,
    options: UploadOptions = {}
  ): Promise<UploadResult[]> {
    return Promise.all(files.map(file => this.upload(file.buffer, file.filename, options)));
  }

  /**
   * Delete a file
   */
  static async delete(key: string): Promise<void> {
    const client = await this.getClient();

    await client.send(
      new (await loadS3()).DeleteObjectCommand({
        Bucket: config.storageBucket,
        Key: key,
      })
    );
    // PREMIUM-2: the resized WebP siblings die with their original (deletes of absent keys are no-ops).
    if (canHaveVariants(key)) {
      await Promise.all(
        VARIANT_WIDTHS.map(async w => {
          try {
            await client.send(
              new (await loadS3()).DeleteObjectCommand({
                Bucket: config.storageBucket,
                Key: variantKey(key, w),
              })
            );
          } catch {
            // best effort: a surviving variant is only unreferenced bytes, swept by prefix on store delete
          }
        })
      );
    }
  }

  /** Write one resized variant (key made by `variantKey`, content always WebP). */
  static async putVariant(key: string, body: Uint8Array): Promise<void> {
    if (!isVariantKey(key)) throw new AppError(400, 'INVALID_VARIANT_KEY', 'Not a variant key');
    const client = await this.getClient();
    await client.send(
      new (await loadS3()).PutObjectCommand({
        Bucket: config.storageBucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
  }

  /**
   * Delete multiple files
   */
  static async deleteMultiple(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.delete(key)));
  }

  /**
   * Delete EVERY object under a key prefix (paginated list → batched delete).
   *
   * Used to reclaim R2 storage when a whole tenant is removed: uploads are
   * namespaced as `stores/<storeId>/...` (see composeKey), so the entire set of
   * a store's assets is `deleteByPrefix('stores/<storeId>/')`. Returns the count
   * of objects removed. Caller is responsible for passing a correctly-scoped,
   * trailing-slash prefix so a prefix can never match a sibling tenant
   * (`stores/abc/` never matches `stores/abcd/`).
   */
  /**
   * Delete every object under a prefix and REPORT WHAT SURVIVED.
   *
   * `remaining > 0` means objects were orphaned — the caller must treat that as
   * a failure, not a warning.
   */
  static async deleteByPrefixVerified(
    prefix: string,
    bucket: string = config.storageBucket
  ): Promise<{
    deleted: number;
    failedKeys: string[];
    remaining: number;
  }> {
    if (!prefix || prefix === 'stores/') {
      // Guard: never allow an empty or bucket-wide prefix to wipe everything.
      throw new AppError(400, 'INVALID_PREFIX', 'deleteByPrefix requires a scoped prefix');
    }
    const client = await this.getClient();
    let deleted = 0;
    const failedKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const listed = await client.send(
        new (await loadS3()).ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const objects = (listed.Contents ?? [])
        .map(o => o.Key)
        .filter((k): k is string => Boolean(k))
        .map(Key => ({ Key }));

      if (objects.length > 0) {
        // DeleteObjects caps at 1000 keys/request; ListObjectsV2 also caps the
        // page at 1000, so one delete per page stays within the limit.
        // Quiet:false, and the response is actually READ.
        //
        // The previous implementation sent Quiet:true (errors only) and then
        // never inspected the result, incrementing the counter by
        // objects.length unconditionally. Per-key failures were therefore
        // invisible and the returned count was fiction — a purge could report
        // success having deleted nothing.
        const res = await client.send(
          new (await loadS3()).DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: false },
          })
        );
        deleted += (res.Deleted ?? []).length;
        for (const e of res.Errors ?? []) if (e.Key) failedKeys.push(e.Key);
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    // One bounded retry for reported failures. R2 delete errors are usually
    // transient; a single focused re-attempt clears them without turning a
    // tenant delete into an unbounded loop.
    if (failedKeys.length > 0) {
      const retrying = failedKeys.splice(0, failedKeys.length);
      for (let i = 0; i < retrying.length; i += 1000) {
        const batch = retrying.slice(i, i + 1000).map(Key => ({ Key }));
        try {
          const res = await client.send(
            new (await loadS3()).DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch, Quiet: false },
            })
          );
          deleted += (res.Deleted ?? []).length;
          for (const e of res.Errors ?? []) if (e.Key) failedKeys.push(e.Key);
        } catch {
          for (const o of batch) failedKeys.push(o.Key);
        }
      }
    }

    // VERIFY instead of assuming. A delete that reported success but left
    // objects behind is the exact failure this method exists to rule out.
    let remaining = 0;
    let verifyToken: string | undefined;
    do {
      const check = await client.send(
        new (await loadS3()).ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: verifyToken,
        })
      );
      remaining += (check.Contents ?? []).length;
      verifyToken = check.IsTruncated ? check.NextContinuationToken : undefined;
    } while (verifyToken);

    return { deleted, failedKeys, remaining };
  }

  /**
   * Back-compat wrapper returning just the count. Prefer
   * `deleteByPrefixVerified` — it reports what SURVIVED, which is the only
   * thing that distinguishes a real purge from a silent orphan.
   */
  static async deleteByPrefix(prefix: string): Promise<number> {
    const { deleted } = await this.deleteByPrefixVerified(prefix);
    return deleted;
  }

  // ── PRIVATE bucket (ruling TAX-4) ───────────────────────────────────────
  // PII evidence (merchant tax cards / VAT certificates) lives ONLY in
  // `config.storagePrivateBucket`, a bucket with no public access. Objects are
  // never given a URL: the API streams them to an authorised caller. FAIL
  // CLOSED — with no private bucket configured (or one equal to the public
  // bucket, which would make it public), every private call is refused, so a
  // tax card can never fall back into the public bucket.

  /** The private bucket name, or a 503 when it is not safely configured. */
  static privateBucket(): string {
    const bucket = (config.storagePrivateBucket ?? '').trim();
    if (!this.isAvailable() || !bucket || bucket === config.storageBucket) {
      throw new AppError(
        503,
        'PRIVATE_STORAGE_NOT_CONFIGURED',
        'Private document storage is not configured. / تخزين المستندات الخاصة غير مُعَد.'
      );
    }
    return bucket;
  }

  /** Store bytes in the private bucket under `stores/<storeId>/<folder>/<uuid><ext>`. */
  static async putPrivate(
    buffer: Buffer,
    args: { storeId: string; folder: string; ext: string; contentType: string }
  ): Promise<{ key: string }> {
    const bucket = this.privateBucket();
    const folder = args.folder.replace(/[^a-zA-Z0-9_-]/g, '');
    const ext = args.ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 8);
    if (!args.storeId || !folder) {
      throw new AppError(400, 'MISSING_TENANT', 'A private object must be store-scoped');
    }
    const key = `stores/${args.storeId}/${folder}/${randomUUID()}${ext}`;
    const client = await this.getClient();
    await client.send(
      new (await loadS3()).PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: args.contentType,
        CacheControl: 'private, no-store',
      })
    );
    return { key };
  }

  /**
   * Store bytes in the private bucket under an EXPLICIT key (write-once archives and ledgers whose key must be derivable, Ruling
   * NZ-D15B). Only the `closed-store-purge/` and `closed-store-archive/` prefixes: a caller can never overwrite a tenant object.
   * `ifAbsent` refuses to replace an existing object (a verified archive is never overwritten).
   */
  static async putPrivateAt(
    key: string,
    buffer: Buffer,
    contentType: string,
    opts: { ifAbsent?: boolean } = {}
  ): Promise<void> {
    if (!/^closed-store-(purge|archive)\/[0-9a-fA-F-]{8,64}\/[A-Za-z0-9._-]+$/.test(key))
      throw new AppError(400, 'BAD_PRIVATE_KEY', 'This private key prefix is not allowed');
    const bucket = this.privateBucket();
    const client = await this.getClient();
    await client.send(
      new (await loadS3()).PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'private, no-store',
        ...(opts.ifAbsent ? { IfNoneMatch: '*' } : {}),
      })
    );
  }

  /** Read a private object's bytes. The caller authorises the request first. */
  static async getPrivate(key: string): Promise<{ body: Buffer; contentType: string | null }> {
    const bucket = this.privateBucket();
    const client = await this.getClient();
    const out = await client.send(
      new (await loadS3()).GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!out.Body) throw new AppError(404, 'NOT_FOUND', 'File not found');
    const bytes = await (
      out.Body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return { body: Buffer.from(bytes), contentType: out.ContentType ?? null };
  }

  static async deletePrivate(key: string): Promise<void> {
    const bucket = this.privateBucket();
    const client = await this.getClient();
    await client.send(new (await loadS3()).DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * Generate a signed URL for private file access
   */
  static async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const client = await this.getClient();

    const command = new (await loadS3()).GetObjectCommand({
      Bucket: config.storageBucket,
      Key: key,
    });

    const { getSignedUrl } = await loadS3Presigner();
    return getSignedUrl(client, command, { expiresIn });
  }

  /**
   * One page of a store's uploaded images, newest first within the page
   * (visual builder media picker). `prefix` MUST be a tenant prefix
   * (`stores/<storeId>/...`): the caller derives it from a store id that
   * passed the ownership check, never from user input.
   */
  static async listByPrefix(
    prefix: string,
    opts: { cursor?: string; limit?: number } = {}
  ): Promise<{
    items: Array<{ key: string; url: string; size: number; lastModified: string | null }>;
    nextCursor: string | null;
  }> {
    if (!/^stores\/[0-9a-f-]{36}\//i.test(prefix)) {
      throw new AppError(400, 'INVALID_PREFIX', 'listByPrefix requires a store-scoped prefix');
    }
    const client = await this.getClient();
    const listed = await client.send(
      new (await loadS3()).ListObjectsV2Command({
        Bucket: config.storageBucket,
        Prefix: prefix,
        ContinuationToken: opts.cursor,
        MaxKeys: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      })
    );
    const items = (listed.Contents ?? [])
      .filter((o): o is typeof o & { Key: string } => Boolean(o.Key))
      .filter(o => /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(o.Key))
      .map(o => ({
        key: o.Key,
        url: this.getPublicUrl(o.Key),
        size: o.Size ?? 0,
        lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
      }))
      .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
    return {
      items,
      nextCursor: listed.IsTruncated ? (listed.NextContinuationToken ?? null) : null,
    };
  }

  /** S3-X8: every object under `stores/<storeId>/` (originals and variants), sizes only, 1000 keys a page. */
  static async listStoreSizes(
    storeId: string,
    cursor?: string
  ): Promise<{ sizes: number[]; nextCursor: string | null }> {
    if (!/^[0-9a-f-]{36}$/i.test(storeId)) {
      throw new AppError(400, 'INVALID_PREFIX', 'listStoreSizes requires a store id');
    }
    const client = await this.getClient();
    const listed = await client.send(
      new (await loadS3()).ListObjectsV2Command({
        Bucket: config.storageBucket,
        Prefix: `stores/${storeId}/`,
        ContinuationToken: cursor,
        MaxKeys: 1000,
      })
    );
    return {
      sizes: (listed.Contents ?? []).map(o => o.Size ?? 0),
      nextCursor: listed.IsTruncated ? (listed.NextContinuationToken ?? null) : null,
    };
  }

  /**
   * Get public URL for a file
   */
  static getPublicUrl(key: string): string {
    if (config.storagePublicUrl) {
      return `${config.storagePublicUrl}/${key}`;
    }
    return `${config.storageEndpoint}/${config.storageBucket}/${key}`;
  }

  /**
   * Extract key from URL
   */
  static getKeyFromUrl(url: string): string | null {
    const publicUrl =
      config.storagePublicUrl || `${config.storageEndpoint}/${config.storageBucket}`;
    if (url.startsWith(publicUrl)) {
      return url.replace(`${publicUrl}/`, '');
    }
    return null;
  }

  /**
   * Compose the final R2 object key for a new upload.
   *
   * Two shapes:
   * - Tenant-scoped: when `storeId` is provided AND `folder` is in the
   *   whitelist, the key is `stores/<storeId>/<folder>/<uuid>-<safeName>`.
   * - Legacy/platform: when `storeId` is null (e.g. super_admin uploading
   *   a platform asset), the key is `<folder>/<uuid>-<safeName>` so platform
   *   assets aren't accidentally tenant-scoped.
   *
   * Disallowed `folder` values when tenant-scoping is requested are
   * rejected with INVALID_FOLDER. Callers should already pass a clean
   * folder hint, but we double-check here so the constraint lives next
   * to the key composition.
   */
  private static composeKey(args: {
    folder: string;
    storeId: string | null;
    filename?: string;
    originalFilename: string;
    ext: string;
  }): string {
    const { folder, storeId, filename, originalFilename, ext } = args;
    const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, '');
    const id = filename || randomUUID();
    const safeName = sanitizeFilename(path.basename(originalFilename, ext));

    if (storeId) {
      if (!ALLOWED_TENANT_FOLDERS.has(safeFolder)) {
        throw new AppError(
          400,
          'INVALID_FOLDER',
          `Folder '${safeFolder}' is not allowed. Allowed: ${Array.from(ALLOWED_TENANT_FOLDERS).join(', ')}`
        );
      }
      return `stores/${storeId}/${safeFolder}/${id}-${safeName}${ext}`;
    }

    // NO TENANT => HARD FAILURE. This used to fall through to a root-level
    // `<folder>/<id><ext>` key, and that silent fallthrough is what produced the
    // 9 unattributable objects found on 2026-08-09: `branding/`, `categories/`
    // and `hero/` files sitting at bucket root, belonging to a real merchant but
    // provably attributable to none.
    //
    // The cost of that is not tidiness. `deleteByPrefix('stores/<storeId>/')` is
    // how a tenant's storage is reclaimed on offboarding, so a root-level object
    // survives its owner's deletion FOREVER, and per-client storage cannot be
    // measured — which is exactly the question that could not be answered when
    // pricing came up.
    //
    // Platform-owned (non-tenant) data does exist — `audit-archive/` — but it
    // writes its key directly through the S3 client and never reaches this
    // function. So there is no legitimate caller for a tenant-less key here, and
    // throwing turns "namespaced by convention" into "namespaced structurally".
    //
    // If genuinely platform-scoped uploads ever need this path, add an explicit
    // PLATFORM_FOLDERS allowlist rather than restoring the silent fallthrough:
    // the failure mode to avoid is an unattributable object, not a strict check.
    throw new AppError(
      400,
      'MISSING_TENANT',
      `Refusing to write an un-namespaced R2 key for folder '${safeFolder}': every upload must be scoped to a storeId so it can be attributed and reclaimed on tenant delete.`
    );
  }

  /**
   * Get MIME type from filename
   */
  private static getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Validate image dimensions (optional, requires sharp)
   */
  static async validateImageDimensions(
    _buffer: Buffer,
    _options: { minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number }
  ): Promise<boolean> {
    // This would require sharp package for image processing
    // For now, return true - implement when sharp is added
    return true;
  }
}
