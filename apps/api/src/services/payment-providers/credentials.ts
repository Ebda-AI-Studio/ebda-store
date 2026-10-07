/**
 * Per-merchant provider credentials (SP6a, catalog form since 2026-10-07, ruling PROVIDERS-1).
 *
 * STORAGE. One `payment_configs` row per (store, provider). The credentials are ONE encrypted
 * JSON blob in `payment_configs.credentials` (AES-256-GCM through `encryption.service`, keyed by
 * `ENCRYPTION_KEY`):
 *
 *     { "sandbox": { "<catalog field key>": "<value>", ... }, "live": { ... } }
 *
 * The field keys are the catalog's (`PROVIDER_CATALOG` in @force/shared), so a provider with any
 * number of secrets fits, and sandbox and live keys are kept apart: switching mode never sends a
 * test key to a live host. `payment_configs.test_mode` picks the active set.
 *
 * Rows saved before the blob existed are read from the four legacy encrypted columns (api_key,
 * secret_key, merchant_id, webhook_secret) until the contract migration drops them.
 *
 * HANDLING. Decrypted only here, at the moment of a provider call, into a `ProviderCredentials`
 * handed to the adapter and dropped. Never logged (`describeForLog` is the only loggable view),
 * never returned by an API (the admin sees `credential_hints`: "saved" + last 4 of a secret, the
 * value of a non-secret field), never stored in `payments.metadata`.
 *
 * `settings` (Kashier page language, Fawry methods, InstaPay handle, COD percentage) are NOT
 * secrets and stay in the `settings` JSON column; per-mode non-secret values (Paymob public key and
 * integration ids) live in the blob because they differ between sandbox and live.
 */
import { getProviderEntry, type CredentialMode, type ProviderCatalogEntry } from '@force/shared';
import { encryption } from '../encryption.service';
import type { ProviderCredentials, ProviderMode } from './types';

export interface PaymentConfigCredentialRow {
  provider: string;
  apiKey?: string | null;
  secretKey?: string | null;
  merchantId?: string | null;
  webhookSecret?: string | null;
  /** Encrypted catalog blob (see the header). */
  credentials?: string | null;
  testMode: boolean;
  settings?: unknown;
  fixedFee?: number | null;
}

/** Decrypted blob: fields per mode. */
export type CredentialBlob = Partial<Record<CredentialMode, Record<string, string>>>;

/** Non-secret display data, stored in `credential_hints`. */
export type CredentialHint = { set: true; last4?: string } | { set: true; value: string };
export type CredentialHints = Partial<Record<CredentialMode, Record<string, CredentialHint>>> & {
  /**
   * `connectionFingerprint` of each mode's stored set, computed at SAVE time. Keyed HMAC, so it
   * reveals nothing about the values; it lets read paths answer "is the last test still current?"
   * without decrypting anything (#2010: reads never decrypt).
   */
  fingerprints?: Partial<Record<CredentialMode, string>>;
};

export function modeOf(row: Pick<PaymentConfigCredentialRow, 'testMode'>): ProviderMode {
  return row.testMode ? 'sandbox' : 'live';
}

function plainObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function encryptCredentialBlob(blob: CredentialBlob): string {
  return encryption.encrypt(JSON.stringify(blob));
}

export function decryptCredentialBlob(cipher: string | null | undefined): CredentialBlob {
  if (!cipher) return {};
  const parsed = JSON.parse(encryption.decrypt(cipher)) as unknown;
  const out: CredentialBlob = {};
  for (const mode of ['sandbox', 'live'] as const) {
    const set = plainObject(plainObject(parsed)[mode]);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(set)) if (typeof v === 'string') clean[k] = v;
    if (Object.keys(clean).length > 0) out[mode] = clean;
  }
  return out;
}

/**
 * The last 4 characters of a secret are shown only when the secret is long enough that 4
 * characters say little about it; a short secret shows "saved" only.
 */
const LAST4_MIN_LENGTH = 16;

/** Display hints for a blob: never contains a secret. */
export function hintsFor(entry: ProviderCatalogEntry, blob: CredentialBlob): CredentialHints {
  const hints: CredentialHints = { fingerprints: {} };
  for (const mode of ['sandbox', 'live'] as const) {
    const set = blob[mode];
    if (!set) continue;
    const modeHints: Record<string, CredentialHint> = {};
    for (const field of entry.fields) {
      const v = set[field.key];
      if (!v) continue;
      modeHints[field.key] = field.secret
        ? v.length >= LAST4_MIN_LENGTH
          ? { set: true, last4: v.slice(-4) }
          : { set: true }
        : { set: true, value: v };
    }
    hints[mode] = modeHints;
    hints.fingerprints![mode] = connectionFingerprint(entry.code, mode, set);
  }
  return hints;
}

/**
 * Keyed fingerprint of the credentials a Test connection proved: provider + mode + that mode's
 * fields, HMAC-SHA256 under a key derived from ENCRYPTION_KEY (`encryption.hash`). Any edit to a
 * field of the active mode, or a mode switch, yields a different value, so a stale successful
 * test can never enable new credentials.
 */
export function connectionFingerprint(
  provider: string,
  mode: CredentialMode,
  fields: Record<string, string> | undefined
): string {
  const sorted = Object.keys(fields ?? {})
    .sort()
    .map(k => [k, (fields ?? {})[k]]);
  return encryption.hash(JSON.stringify(['provider-connection-v1', provider, mode, sorted]));
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
}

/** Map one mode's catalog fields onto the adapter's `ProviderCredentials` slots. */
export function bindCredentialFields(
  entry: ProviderCatalogEntry,
  fields: Record<string, string>,
  mode: ProviderMode,
  commonSettings: Record<string, unknown>
): ProviderCredentials {
  const creds: ProviderCredentials = { mode, settings: { ...commonSettings } };
  for (const field of entry.fields) {
    const raw = fields[field.key];
    if (raw === undefined || raw === '') continue;
    const value = field.type === 'integer' ? Number(raw) : raw;
    if (field.bind.startsWith('settings.')) {
      setPath(creds.settings as Record<string, unknown>, field.bind.split('.').slice(1), value);
    } else {
      (creds as unknown as Record<string, unknown>)[field.bind] = String(value);
    }
  }
  return creds;
}

/** Decrypt a stored config for ONE provider call. The result must not outlive that call. */
export function toProviderCredentials(row: PaymentConfigCredentialRow): ProviderCredentials {
  const mode = modeOf(row);
  // `fixedFeeMinor` rides along so COD needs no second lookup; both are non-secret.
  const common = { ...plainObject(row.settings), fixedFeeMinor: Number(row.fixedFee ?? 0) };
  const entry = getProviderEntry(row.provider);
  if (row.credentials && entry) {
    const blob = decryptCredentialBlob(row.credentials);
    return bindCredentialFields(entry, blob[mode] ?? {}, mode, common);
  }
  // Legacy rows (expand phase): the four fixed encrypted columns.
  return {
    apiKey: row.apiKey ? encryption.decrypt(row.apiKey) : undefined,
    secretKey: row.secretKey ? encryption.decrypt(row.secretKey) : undefined,
    merchantId: row.merchantId ? encryption.decrypt(row.merchantId) : undefined,
    webhookSecret: row.webhookSecret ? encryption.decrypt(row.webhookSecret) : undefined,
    mode,
    settings: common,
  };
}

/** The ONLY description of a config that may be logged: no secret, not even a fingerprint. */
export function describeForLog(row: PaymentConfigCredentialRow): Record<string, unknown> {
  return {
    provider: row.provider,
    mode: modeOf(row),
    hasCredentialBlob: Boolean(row.credentials),
    hasApiKey: Boolean(row.apiKey),
    hasSecretKey: Boolean(row.secretKey),
    hasMerchantId: Boolean(row.merchantId),
    hasWebhookSecret: Boolean(row.webhookSecret),
  };
}
