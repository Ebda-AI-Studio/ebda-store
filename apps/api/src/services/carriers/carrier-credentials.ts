/**
 * Per-merchant carrier credentials (shipping batch, rulings PROVIDERS-1 / PROVIDERS-9).
 *
 * STORAGE. One `shipping_carrier_configs` row per (store, carrier). `credentials` is ONE
 * AES-256-GCM ciphertext (`encryption.service`, keyed by `ENCRYPTION_KEY`) of
 *
 *     { "sandbox": { "<catalog field key>": "<value>" }, "live": { ... }, "webhookSecret": "<hex>" }
 *
 * Sandbox and live keys are kept apart (switching mode never sends a test key to a live host);
 * `shipping_carrier_configs.test_mode` picks the active set. `webhookSecret` is server-made, the
 * same for both modes, and authenticates the carrier's callbacks: it is never a catalog field, so
 * a merchant can neither read nor set it.
 *
 * Rows saved before the catalog form (a flat `{apiKey, ...}` map, optionally with `webhookSecret`)
 * are read as the LIVE set (or the sandbox set when `settings.sandbox` was true) until their next
 * save rewrites them in this shape. Nothing here migrates data in SQL: the ciphertext cannot be
 * read there.
 *
 * HANDLING. Decrypted only here, for one carrier call, into the flat map the adapter takes
 * (`activeCredentials`). Never logged, never returned to a browser: the admin sees
 * `credential_hints` ("saved" + last 4 of a long secret, the value of a non-secret field).
 */
import type { CredentialMode, ProviderCatalogEntry } from '@ebda/shared';
import { encryption } from '../encryption.service';
import {
  connectionFingerprint,
  hintsFor,
  type CredentialBlob,
  type CredentialHints,
} from '../payment-providers/credentials';

export interface CarrierBlob extends CredentialBlob {
  webhookSecret?: string;
}

export interface CarrierCredentialRow {
  carrier: string;
  testMode: boolean;
  credentials?: string | null;
  settings?: unknown;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function stringsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isPlain(v))
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

export function modeOfRow(row: Pick<CarrierCredentialRow, 'testMode'>): CredentialMode {
  return row.testMode ? 'sandbox' : 'live';
}

/**
 * Decrypt a stored blob. Throws on ciphertext that does not decrypt: that is a bug or a rotated
 * key, and reading it as "no credentials" would let the next save erase the real ones.
 */
export function decryptCarrierBlob(
  cipher: string | null | undefined,
  settings?: unknown
): CarrierBlob {
  if (!cipher) return {};
  if (typeof cipher !== 'string') {
    throw new Error(
      'carrier credentials are not an encrypted string: refusing to read them as empty'
    );
  }
  const parsed = JSON.parse(encryption.decrypt(cipher)) as unknown;
  const root = isPlain(parsed) ? parsed : {};
  const out: CarrierBlob = {};
  const webhookSecret = typeof root.webhookSecret === 'string' ? root.webhookSecret : undefined;
  if (webhookSecret) out.webhookSecret = webhookSecret;
  if (isPlain(root.sandbox) || isPlain(root.live)) {
    for (const mode of ['sandbox', 'live'] as const) {
      const set = stringsOf(root[mode]);
      if (Object.keys(set).length > 0) out[mode] = set;
    }
    return out;
  }
  // Legacy flat map.
  const { webhookSecret: _w, ...flat } = stringsOf(root);
  if (Object.keys(flat).length > 0) {
    const legacySandbox =
      isPlain(settings) && (settings.sandbox === true || settings.sandbox === 'true');
    out[legacySandbox ? 'sandbox' : 'live'] = flat;
  }
  return out;
}

export function encryptCarrierBlob(blob: CarrierBlob): string {
  return encryption.encrypt(JSON.stringify(blob));
}

/** The active mode's fields as the flat map the adapter takes, plus `webhookSecret`. */
export function activeCredentials(row: CarrierCredentialRow): Record<string, string> {
  const blob = decryptCarrierBlob(row.credentials, row.settings);
  return {
    ...(blob[modeOfRow(row)] ?? {}),
    ...(blob.webhookSecret ? { webhookSecret: blob.webhookSecret } : {}),
  };
}

/** The active mode's catalog fields only (no `webhookSecret`): what a Test connection proves. */
export function activeFieldSet(row: CarrierCredentialRow): Record<string, string> {
  return decryptCarrierBlob(row.credentials, row.settings)[modeOfRow(row)] ?? {};
}

export function carrierHints(entry: ProviderCatalogEntry, blob: CarrierBlob): CredentialHints {
  return hintsFor(entry, blob);
}

export function carrierFingerprint(
  carrier: string,
  mode: CredentialMode,
  fields: Record<string, string>
): string {
  return connectionFingerprint(carrier, mode, fields);
}
