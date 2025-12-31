import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
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
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
}

// Allowed image types
const DEFAULT_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

// Max file size: 10MB
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

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

    // Generate unique filename
    const ext = path.extname(originalFilename).toLowerCase();
    const key = `${folder}/${filename || uuidv4()}${ext}`;

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
    expiresIn = 3600
  ): Promise<{ uploadUrl: string; key: string; publicUrl: string }> {
    const ext = path.extname(filename).toLowerCase();
    const key = `${folder}/${uuidv4()}${ext}`;

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
