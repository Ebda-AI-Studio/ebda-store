import type { D1Migration } from 'cloudflare:test';

/** Service Binding RPC surface of ebda-api (apps/api/src/cf/identity-rpc.ts). */
export interface StoreDirectoryRpc {
  /** The stores a user may act on: owner = Store.ownerId, staff = a StoreStaff row. */
  storesForUser(userId: string): Promise<Array<{ id: string; role: 'owner' | 'staff' }>>;
  /** Is the store still in the directory (not deleted)? Integrator clients of a deleted store are refused. */
  storeExists(storeId: string): Promise<boolean>;
  /** Not deleted AND not suspended: integrator clients may act only while this is true. */
  storeActive(storeId: string): Promise<boolean>;
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

/** Service Binding RPC surface of ebda-wa (its `PlatformOtp` entrypoint, src/index.ts in ebda-whatsapp): sends from the PLATFORM number, no store id. Anything but `ok` means: fall back to the email. */
export interface WhatsAppOtpRpc {
  sendCode(phone: string, code: string): Promise<{ ok: true } | { ok: false; reason: string }>;
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
      /** Set per deploy (`--var BUILD_COMMIT_SHA:$GITHUB_SHA`); empty locally. */
      BUILD_COMMIT_SHA?: string;
      CF_VERSION_METADATA?: { id?: string; tag?: string };
      /** `origin=product` pairs: the only audience a browser origin may request. */
      ORIGIN_PRODUCTS: string;
      /** AES-256-GCM key (base64) for TOTP secrets at rest (wrangler secret). */
      MFA_KEY?: string;
      /** The previous MFA key while a rotation is in flight (opens old secrets; never used to seal). */
      MFA_KEY_PREV?: string;
      /** 'true' after the re-encrypt job reports 0 remaining: refuse legacy v1/v2 sealed secrets. */
      MFA_REJECT_LEGACY?: string;
      /** HMAC key (base64, >= 32 bytes) for integrator client secrets at rest (wrangler secret). Missing = the client endpoints answer 503 and log loudly. */
      CLIENT_SECRET_PEPPER?: string;
      STORE_DIRECTORY?: StoreDirectoryRpc;
      MAILER?: MailerRpc;
      /** ebda-wa `PlatformOtp`. Absent = the WhatsApp channel is off (fail closed); the email path never depends on it. */
      WHATSAPP_OTP?: WhatsAppOtpRpc;
      /** 'true' turns the WhatsApp channel on. Default OFF until the platform number exists (Ruling WA-OTP-SENDER-1). */
      WHATSAPP_OTP_ENABLED?: string;
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}
export {};
