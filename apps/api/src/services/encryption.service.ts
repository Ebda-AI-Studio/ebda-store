import crypto from 'crypto';
import { config } from '../config';
import logger from '../lib/logger';

// ==========================================
// Encryption Service
// For securing sensitive data like API keys
// ==========================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

class EncryptionService {
  private key: Buffer | null = null;

  /**
   * Initialize the encryption key from config
   */
  private getKey(): Buffer {
    if (this.key) return this.key;

    const encryptionKey = config.encryptionKey;
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error('ENCRYPTION_KEY must be at least 32 characters');
    }

    // Derive a consistent 32-byte key using SHA-256
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    return this.key;
  }

  /**
   * Encrypt a string value
   * Returns: base64 encoded string containing salt:iv:authTag:encrypted
   */
  encrypt(plaintext: string): string {
    if (!plaintext) return '';

    const key = this.getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    // Derive unique key for this encryption using salt
    const derivedKey = crypto.pbkdf2Sync(key, salt, 10000, 32, 'sha256');

    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv, { authTagLength: 16 });

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Combine salt + iv + authTag + encrypted data
    const combined = Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'hex')]);

    return combined.toString('base64');
  }

  /**
   * Decrypt an encrypted string
   */
  decrypt(encryptedData: string): string {
    if (!encryptedData) return '';

    try {
      const key = this.getKey();
      const combined = Buffer.from(encryptedData, 'base64');

      // Extract components
      const salt = combined.subarray(0, SALT_LENGTH);
      const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const authTag = combined.subarray(
        SALT_LENGTH + IV_LENGTH,
        SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
      );
      const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

      // Derive the same key using the salt
      const derivedKey = crypto.pbkdf2Sync(key, salt, 10000, 32, 'sha256');

      const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv, { authTagLength: 16 });
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error) {
      logger.error({ err: error }, 'Decryption failed');
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Hash a value (one-way, for comparisons)
   */
  hash(value: string): string {
    return crypto.createHmac('sha256', this.getKey()).update(value).digest('hex');
  }

  /**
   * Generate a secure random token
   */
  generateToken(length = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Mask a sensitive value for display (e.g., "sk_****1234")
   */
  mask(value: string, visibleChars = 4): string {
    if (!value || value.length <= visibleChars * 2) {
      return '****';
    }

    const prefix = value.substring(0, visibleChars);
    const suffix = value.substring(value.length - visibleChars);
    return `${prefix}****${suffix}`;
  }

  /**
   * Check if a value is encrypted (basic check)
   */
  isEncrypted(value: string): boolean {
    if (!value) return false;
    try {
      const decoded = Buffer.from(value, 'base64');
      // Check if it has the expected minimum length
      return decoded.length >= SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const encryption = new EncryptionService();
