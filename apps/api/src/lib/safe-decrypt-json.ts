import { AppError } from '../middleware/error-handler';

/**
 * Parse a decrypted credential blob into JSON, converting any malformed-JSON
 * SyntaxError into a typed, operational AppError. Decrypt failures (wrong key,
 * corrupted ciphertext, partial blob) otherwise surface as a raw SyntaxError
 * that leaks a stack trace and returns an opaque 500. This keeps the failure
 * mode explicit and the error code greppable. (C5)
 */
export function safeDecryptJson<T = unknown>(decrypted: string, context: string): T {
  try {
    return JSON.parse(decrypted) as T;
  } catch {
    throw new AppError(
      500,
      'CREDENTIAL_DECRYPT_FAILED',
      `Failed to parse decrypted credential (${context})`
    );
  }
}
