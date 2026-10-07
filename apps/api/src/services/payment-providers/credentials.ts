/**
 * Per-merchant provider credentials (SP6a).
 *
 * Secrets live ONLY in the encrypted `payment_configs` columns (AES-256-GCM
 * through `encryption.service`, keyed by `ENCRYPTION_KEY`, the same mechanism Ebda
 * used). They are decrypted here, at the moment of a provider call, into a
 * `ProviderCredentials` that is handed to the adapter and dropped. They are never
 * logged (`describeForLog` is the only thing that may be logged about a config),
 * never put in an API response (the admin routes return `maskCredentials`:
 * `****` + the last 4 characters captured at save time), and never stored in
 * `payments.metadata`.
 *
 * `settings` (InstaPay handle/phone/expiry, COD percentage) are NOT secrets: they
 * are shown to customers, so they sit in their own `settings` JSON column.
 */
import { encryption } from '../encryption.service';
import type { ProviderCredentials, ProviderMode } from './types';

export interface PaymentConfigCredentialRow {
  provider: string;
  apiKey?: string | null;
  secretKey?: string | null;
  merchantId?: string | null;
  webhookSecret?: string | null;
  testMode: boolean;
  settings?: unknown;
  fixedFee?: number | null;
}

export function modeOf(row: Pick<PaymentConfigCredentialRow, 'testMode'>): ProviderMode {
  return row.testMode ? 'sandbox' : 'live';
}

function plainObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Decrypt a stored config for ONE provider call. The result must not outlive that call. */
export function toProviderCredentials(row: PaymentConfigCredentialRow): ProviderCredentials {
  return {
    apiKey: row.apiKey ? encryption.decrypt(row.apiKey) : undefined,
    secretKey: row.secretKey ? encryption.decrypt(row.secretKey) : undefined,
    merchantId: row.merchantId ? encryption.decrypt(row.merchantId) : undefined,
    webhookSecret: row.webhookSecret ? encryption.decrypt(row.webhookSecret) : undefined,
    mode: modeOf(row),
    // `fixedFeeMinor` rides along so COD needs no second lookup; both are non-secret.
    settings: { ...plainObject(row.settings), fixedFeeMinor: Number(row.fixedFee ?? 0) },
  };
}

/** The ONLY description of a config that may be logged: no secret, not even a fingerprint. */
export function describeForLog(row: PaymentConfigCredentialRow): Record<string, unknown> {
  return {
    provider: row.provider,
    mode: modeOf(row),
    hasApiKey: Boolean(row.apiKey),
    hasSecretKey: Boolean(row.secretKey),
    hasMerchantId: Boolean(row.merchantId),
    hasWebhookSecret: Boolean(row.webhookSecret),
  };
}
