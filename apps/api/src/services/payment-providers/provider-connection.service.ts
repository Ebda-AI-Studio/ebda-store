/**
 * "Connect a provider" (Batch 0, plan section 4.2/4.3): save credentials, Test connection, and
 * the enable gate. The routes in `payment-settings.routes.ts` are thin wrappers around this.
 *
 *  - Credentials are WRITE-ONLY: saved into the encrypted blob (`credentials.ts`); the browser
 *    only ever gets `credential_hints` back.
 *  - Test connection runs the adapter's ONE harmless authenticated call for the ACTIVE mode and
 *    records `{ok, code, mode, at, fingerprint}` in `connection_test`.
 *  - A gateway may be enabled only when (a) the catalog lets it be used (PROVIDERS-2) and (b) the
 *    last Test connection succeeded for EXACTLY the credentials now stored for the active mode
 *    (fingerprint match). Any edit or mode switch invalidates it by construction.
 */
import {
  getProviderEntry,
  isMaskedSecret,
  missingRequiredFields,
  validateCredentialValue,
  type CredentialMode,
  type ProviderCatalogEntry,
} from '@force/shared';
import { AppError } from '../../middleware/error-handler';
import {
  bindCredentialFields,
  connectionFingerprint,
  decryptCredentialBlob,
  encryptCredentialBlob,
  hintsFor,
  modeOf,
  type CredentialBlob,
  type CredentialHints,
} from './credentials';
import { isProviderUsable } from './provider-gate';
import { getProviderV2 } from './registry';
import type { ConnectionTestResult } from './types';
import { paymentWebhookUrl } from './webhook-url';

/** What `connection_test` holds. `fingerprint` is set only for a successful test. */
export interface StoredConnectionTest {
  ok: boolean;
  code: ConnectionTestResult['code'];
  mode: CredentialMode;
  at: string;
  fingerprint: string | null;
}

export interface ConnectableRow {
  provider: string;
  testMode: boolean;
  isEnabled: boolean;
  credentials?: string | null;
  credentialHints?: unknown;
  connectionTest?: unknown;
  settings?: unknown;
}

/** The catalog entry of a NON-manual provider, or a 404/422 the route can return as is. */
export function connectableEntry(provider: string): ProviderCatalogEntry {
  const entry = getProviderEntry(provider);
  if (!entry || entry.kind !== 'payments') {
    throw new AppError(404, 'UNKNOWN_PROVIDER', `Unknown payment provider "${provider}"`);
  }
  if (entry.manual) {
    throw new AppError(422, 'NO_CREDENTIALS', `${provider} has no credentials to connect`);
  }
  return entry;
}

/**
 * PROVIDERS-2 for writes: a merchant cannot connect a "coming soon" provider; a super admin may
 * save and TEST its credentials (that is how it gets verified), but nobody can enable it.
 */
export function assertMayConfigure(provider: string, role: string): void {
  if (isProviderUsable(provider)) return;
  if (role === 'super_admin') return;
  throw new AppError(
    403,
    'PROVIDER_NOT_AVAILABLE',
    `${provider} is coming soon: it has not been verified against its sandbox yet`
  );
}

export interface CredentialUpdate {
  mode: CredentialMode;
  /** Field values; '' / undefined / a masked echo (`****...`) keep the stored value; null clears it. */
  fields: Record<string, string | number | null | undefined>;
}

export interface CredentialUpdateResult {
  cipher: string;
  hints: CredentialHints;
  /** Keys whose value changed (for the audit log: names only, never values). */
  changed: string[];
  /** Whether the ACTIVE mode's credentials changed (so an enabled provider must be re-tested). */
  activeModeChanged: boolean;
}

/**
 * Validate `fields` against the catalog and merge them over `current` (one mode's stored values).
 * Shared by the payment and the shipping connect routes: '' / undefined / a masked echo keep the
 * stored value, null clears it, anything else must pass the field's own validation.
 */
export function mergeCredentialFields(
  entry: ProviderCatalogEntry,
  current: Record<string, string>,
  fields: Record<string, string | number | null | undefined>
): { next: Record<string, string>; changed: string[] } {
  const next = { ...current };
  const known = new Map(entry.fields.map(f => [f.key, f]));
  const errors: string[] = [];
  const changed: string[] = [];

  for (const [key, raw] of Object.entries(fields)) {
    const field = known.get(key);
    if (!field) {
      errors.push(`${key}: not a ${entry.code} credential`);
      continue;
    }
    if (raw === undefined || raw === '' || isMaskedSecret(raw)) continue;
    if (raw === null) {
      if (next[key] !== undefined) {
        delete next[key];
        changed.push(key);
      }
      continue;
    }
    const value = String(raw).trim();
    const problem = validateCredentialValue(field, value);
    if (problem) {
      errors.push(`${key}: ${problem}`);
      continue;
    }
    if (next[key] !== value) {
      next[key] = value;
      changed.push(key);
    }
  }
  if (errors.length > 0) {
    throw new AppError(422, 'INVALID_CREDENTIALS', errors.join('; '));
  }
  return { next, changed };
}

/** Validate an update against the catalog and merge it into the stored blob. */
export function applyCredentialUpdate(
  entry: ProviderCatalogEntry,
  row: Pick<ConnectableRow, 'credentials' | 'testMode'> | null,
  update: CredentialUpdate
): CredentialUpdateResult {
  const blob: CredentialBlob = decryptCredentialBlob(row?.credentials ?? null);
  const { next: current, changed } = mergeCredentialFields(
    entry,
    blob[update.mode] ?? {},
    update.fields
  );
  const next: CredentialBlob = { ...blob, [update.mode]: current };
  return {
    cipher: encryptCredentialBlob(next),
    hints: hintsFor(entry, next),
    changed,
    activeModeChanged:
      changed.length > 0 && modeOf({ testMode: row?.testMode ?? true }) === update.mode,
  };
}

function storedTest(row: ConnectableRow): StoredConnectionTest | null {
  const t = row.connectionTest;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  return t as StoredConnectionTest;
}

/** The active mode's decrypted fields of a row. */
function activeFields(row: ConnectableRow): Record<string, string> {
  return decryptCredentialBlob(row.credentials ?? null)[modeOf(row)] ?? {};
}

/**
 * True when the last successful test covers exactly the credentials now active. AUTHORITATIVE:
 * decrypts and recomputes the fingerprint (write paths: the enable gate).
 */
export function connectionTestIsCurrent(row: ConnectableRow): boolean {
  const t = storedTest(row);
  if (!t?.ok || !t.fingerprint || !row.credentials) return false;
  const mode = modeOf(row);
  if (t.mode !== mode) return false;
  let fields: Record<string, string>;
  try {
    fields = activeFields(row);
  } catch {
    // Undecryptable (e.g. ENCRYPTION_KEY rotated): nothing proven is current.
    return false;
  }
  return t.fingerprint === connectionFingerprint(row.provider, mode, fields);
}

/**
 * The same answer for READ paths without decrypting: compares the test's fingerprint with the
 * one stored in `credential_hints` at save time. Display only; enabling always uses the
 * authoritative check above.
 */
export function connectionTestLooksCurrent(row: ConnectableRow): boolean {
  const t = storedTest(row);
  if (!t?.ok || !t.fingerprint || !row.credentials) return false;
  const mode = modeOf(row);
  const hints = (row.credentialHints ?? {}) as CredentialHints;
  return t.mode === mode && t.fingerprint === hints.fingerprints?.[mode];
}

/**
 * The enable gate, for EVERY write path that can leave a non-manual provider enabled (create,
 * update, toggle, mode switch). Manual providers (COD, InstaPay) are not gated here.
 */
export function assertEnableAllowed(row: ConnectableRow): void {
  const entry = getProviderEntry(row.provider);
  if (!entry || entry.kind !== 'payments') {
    throw new AppError(422, 'UNKNOWN_PROVIDER', `Unknown payment provider "${row.provider}"`);
  }
  if (entry.manual) return;
  if (!isProviderUsable(row.provider)) {
    throw new AppError(
      409,
      'PROVIDER_NOT_VERIFIED',
      `${row.provider} is coming soon and cannot be enabled yet`
    );
  }
  if (!connectionTestIsCurrent(row)) {
    throw new AppError(
      409,
      'CONNECTION_NOT_TESTED',
      'Run Test connection successfully with the current credentials before enabling'
    );
  }
}

/** Run the adapter's harmless call for the row's ACTIVE mode. Never throws for provider errors. */
export async function runConnectionTest(
  row: ConnectableRow
): Promise<{ result: ConnectionTestResult; stored: StoredConnectionTest }> {
  const entry = connectableEntry(row.provider);
  const mode = modeOf(row);
  const fields = activeFields(row);
  const at = new Date().toISOString();
  const missing = missingRequiredFields(entry, fields);
  let result: ConnectionTestResult;
  if (missing.length > 0) {
    result = { ok: false, code: 'incomplete', message: `Missing: ${missing.join(', ')}` };
  } else {
    const adapter = getProviderV2(row.provider);
    if (!adapter?.testConnection) {
      result = { ok: false, code: 'unknown', message: 'This provider has no connection test' };
    } else {
      const settings =
        row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
          ? (row.settings as Record<string, unknown>)
          : {};
      try {
        result = await adapter.testConnection(bindCredentialFields(entry, fields, mode, settings));
      } catch {
        // The contract says adapters never throw; a bug must still not leak a provider body.
        result = { ok: false, code: 'unknown', message: 'Connection test failed unexpectedly' };
      }
    }
  }
  return {
    result,
    stored: {
      ok: result.ok,
      code: result.code,
      mode,
      at,
      fingerprint: result.ok ? connectionFingerprint(row.provider, mode, fields) : null,
    },
  };
}

/**
 * The browser-safe view of a config row: no ciphertext, no fingerprint, no legacy secret columns.
 * Every route that returns a `payment_configs` row returns THIS (write-only credentials).
 */
export function publicPaymentConfig<T extends Record<string, unknown>>(
  row: T,
  storeId: string | null
): Record<string, unknown> {
  // Never sent to a browser: the ciphertext, the legacy encrypted columns (the routes add the
  // masked view of those separately) and the stored fingerprints.
  const rest: Record<string, unknown> = { ...row };
  for (const key of ['credentials', 'apiKey', 'secretKey', 'merchantId', 'webhookSecret']) {
    delete rest[key];
  }
  const connectionTest = rest.connectionTest;
  const t =
    connectionTest && typeof connectionTest === 'object'
      ? (connectionTest as StoredConnectionTest)
      : null;
  const entry = getProviderEntry(String(row.provider));
  const hints: CredentialHints = { ...((rest.credentialHints ?? {}) as CredentialHints) };
  delete hints.fingerprints;
  return {
    ...rest,
    credentialHints: hints,
    connectionTest: t ? { ok: t.ok, code: t.code, mode: t.mode, at: t.at } : null,
    connectionTestCurrent: connectionTestLooksCurrent(row as unknown as ConnectableRow),
    webhookUrl: entry && entry.webhook && storeId ? paymentWebhookUrl(entry.code, storeId) : null,
  };
}
