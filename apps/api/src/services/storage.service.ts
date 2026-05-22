import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';

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
  'misc',
  // Per-store custom fonts uploaded via the typography admin page.
  // Uses the same key shape as everything else: stores/<storeId>/fonts/...
  'fonts',
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
  private static getClient(): S3Client {
    if (!this.client) {
      if (!config.storageEndpoint || !config.storageAccessKey || !config.storageSecretKey) {
        throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Storage service is not configured');
      }

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

    const client = this.getClient();

    await client.send(
      new PutObjectCommand({
        Bucket: config.storageBucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000', // 1 year cache
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
    const client = this.getClient();

    await client.send(
      new DeleteObjectCommand({
        Bucket: config.storageBucket,
        Key: key,
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
   * Generate a signed URL for private file access
   */
  static async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const client = this.getClient();

    const command = new GetObjectCommand({
      Bucket: config.storageBucket,
      Key: key,
    });

    return getSignedUrl(client, command, { expiresIn });
  }

  /**
   * Generate a signed URL for direct upload
   */
  static async getUploadUrl(
    filename: string,
    contentType: string,
    folder = 'uploads',
    expiresIn = 3600,
    storeId: string | null = null
  ): Promise<{ uploadUrl: string; key: string; publicUrl: string }> {
    const ext = path.extname(filename).toLowerCase();
    const key = this.composeKey({
      folder,
      storeId,
      filename: undefined,
      originalFilename: filename,
      ext,
    });

    const client = this.getClient();

    const command = new PutObjectCommand({
      Bucket: config.storageBucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn });

    return {
      uploadUrl,
      key,
      publicUrl: this.getPublicUrl(key),
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

    // Legacy / platform key shape (no rename of existing keys).
    return `${safeFolder || 'uploads'}/${id}${ext}`;
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
