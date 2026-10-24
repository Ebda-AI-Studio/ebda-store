import type { D1Migration } from 'cloudflare:test';

/** Service Binding RPC surface of ebda-api (apps/api/src/cf/identity-rpc.ts). */
export interface StoreDirectoryRpc {
  /** The stores a user may act on: owner = Store.ownerId, staff = a StoreStaff row. */
  storesForUser(userId: string): Promise<Array<{ id: string; role: 'owner' | 'staff' }>>;
}
export interface MailerRpc {
  /** Send a one-time code mail (verification or password reset) through the Store mail pipeline. */
  sendCode(input: {
    to: string;
    kind: 'email_verify' | 'password_reset' | 'staff_invite' | 'factor_enrol';
    code: string;
    language: 'en' | 'ar';
    firstName: string;
    ttlMinutes: number;
    storeName?: string;
  }): Promise<void>;
  /** A security notice with no code (a sign-in method was added). */
  sendNotice(input: {
    to: string;
    kind: 'factor_added';
    factor: 'totp' | 'passkey';
    language: 'en' | 'ar';
    firstName: string;
  }): Promise<void>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      /** ES256 private key as a JWK JSON string with `kid` (wrangler secret). */
      JWT_PRIVATE_JWK: string;
      /** JSON array of PUBLIC JWKs of retired keys, kept published for 24 h after a rotation (var). */
      JWT_PREVIOUS_PUBLIC_JWKS?: string;
      ISSUER: string;
      /** Comma list of browser origins that may call credentialed endpoints (CORS + CSRF origin check). */
      ALLOWED_ORIGINS: string;
      /** Comma list of origins a WebAuthn ceremony may run from; rpId = that origin's hostname. */
      PASSKEY_ORIGINS: string;
      /** Comma list of valid `aud` values. */
      PRODUCTS: string;
      /** AES-256-GCM key (base64) for TOTP secrets at rest (wrangler secret). */
      MFA_KEY?: string;
      STORE_DIRECTORY?: StoreDirectoryRpc;
      MAILER?: MailerRpc;
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}
export {};
