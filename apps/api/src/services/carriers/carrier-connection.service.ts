/**
 * "Connect a carrier" (shipping batch of the provider framework, plan section 4): save the
 * credentials of one mode (write-only), Test connection, and the enable gate. The routes in
 * `shipping-carrier.routes.ts` are thin wrappers around this; the payment twin is
 * `payment-providers/provider-connection.service.ts` (the validation is shared).
 *
 *  - A carrier may be enabled only when (a) the catalog lets it be used (PROVIDERS-2: verified
 *    against its real sandbox, or manual) and (b) the last Test connection succeeded for EXACTLY
 *    the credentials now stored for the active mode (fingerprint match). Any edit or mode switch
 *    invalidates it by construction.
 *  - Test connection is the adapter's ONE harmless authenticated call; it never creates a parcel.
 */
import crypto from 'node:crypto';
import {
  getProviderEntry,
  missingRequiredFields,
  type CredentialMode,
  type ProviderCatalogEntry,
} from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { isProviderUsable } from '../payment-providers/provider-gate';
import { mergeCredentialFields } from '../payment-providers/provider-connection.service';
import type { CredentialHints } from '../payment-providers/credentials';
import {
  activeFieldSet,
  carrierFingerprint,
  carrierHints,
  decryptCarrierBlob,
  encryptCarrierBlob,
  modeOfRow,
  type CarrierBlob,
  type CarrierCredentialRow,
} from './carrier-credentials';
import { getCarrierAdapter } from './registry';
import type { CarrierCallContext } from './types';

export type CarrierTestCode = 'ok' | 'bad_credentials' | 'incomplete' | 'unreachable' | 'unknown';

/** What `connection_test` holds. `fingerprint` is set only for a successful test. */
export interface StoredCarrierTest {
  ok: boolean;
  code: CarrierTestCode;
  mode: CredentialMode;
  at: string;
  fingerprint: string | null;
}

export interface ConnectableCarrierRow extends CarrierCredentialRow {
  enabled: boolean;
  credentialHints?: unknown;
  connectionTest?: unknown;
}

/** The catalog entry of an API carrier, or a 404/422 the route can return as is. */
export function carrierEntry(carrier: string): ProviderCatalogEntry {
  const entry = getProviderEntry(carrier);
  if (!entry || entry.kind !== 'shipping') {
    throw new AppError(404, 'UNKNOWN_CARRIER', `Unknown carrier "${carrier}"`);
  }
  if (entry.manual) {
    throw new AppError(422, 'NO_CREDENTIALS', `${carrier} has no credentials to connect`);
  }
  return entry;
}

/**
 * PROVIDERS-2 as relaxed by PROVIDERS-ACTIVATION, for SAVE and TEST only: every carrier in the
 * catalog accepts a merchant's own credentials and a Test connection, verified or not. ENABLING
 * is still gated by `assertCarrierEnableAllowed`.
 */
export function assertMayConfigureCarrier(carrier: string, _role: string): void {
  // Manual delivery has no credentials and is always configurable (its settings, not a connection).
  if (getProviderEntry(carrier)?.manual) return;
  carrierEntry(carrier);
}

export interface CarrierCredentialUpdate {
  mode: CredentialMode;
  /** Field values; '' / undefined / a masked echo keep the stored value; null clears it. */
  fields: Record<string, string | number | null | undefined>;
}

export interface CarrierCredentialUpdateResult {
  cipher: string;
  hints: CredentialHints;
  /** Keys whose value changed (for the audit log: names only, never values). */
  changed: string[];
  /** Whether the ACTIVE mode's credentials changed (an enabled carrier must be re-tested). */
  activeModeChanged: boolean;
}

/**
 * Validate an update against the catalog and merge it into the stored blob. The server-made
 * `webhookSecret` is kept (and created once for a carrier that has callbacks).
 */
export function applyCarrierCredentialUpdate(
  entry: ProviderCatalogEntry,
  row: CarrierCredentialRow | null,
  update: CarrierCredentialUpdate
): CarrierCredentialUpdateResult {
  const blob: CarrierBlob = decryptCarrierBlob(row?.credentials ?? null, row?.settings);
  const { next, changed } = mergeCredentialFields(entry, blob[update.mode] ?? {}, update.fields);
  const merged: CarrierBlob = { ...blob, [update.mode]: next };
  if (entry.capabilities.webhooks && !merged.webhookSecret) {
    merged.webhookSecret = crypto.randomBytes(24).toString('hex');
  }
  return {
    cipher: encryptCarrierBlob(merged),
    hints: carrierHints(entry, merged),
    changed,
    activeModeChanged:
      changed.length > 0 && modeOfRow({ testMode: row?.testMode ?? true }) === update.mode,
  };
}

/** A fresh blob with a new `webhookSecret` (rotation): the old callback URL stops working. */
export function rotateBlobWebhookSecret(cipher: string | null, settings?: unknown): string {
  const blob = decryptCarrierBlob(cipher, settings);
  blob.webhookSecret = crypto.randomBytes(24).toString('hex');
  return encryptCarrierBlob(blob);
}

function storedTest(row: ConnectableCarrierRow): StoredCarrierTest | null {
  const t = row.connectionTest;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  return t as StoredCarrierTest;
}

/**
 * True when the last successful test covers exactly the credentials now active. AUTHORITATIVE:
 * decrypts and recomputes the fingerprint (the enable gate).
 */
export function carrierTestIsCurrent(row: ConnectableCarrierRow): boolean {
  const t = storedTest(row);
  if (!t?.ok || !t.fingerprint || !row.credentials) return false;
  const mode = modeOfRow(row);
  if (t.mode !== mode) return false;
  try {
    return t.fingerprint === carrierFingerprint(row.carrier, mode, activeFieldSet(row));
  } catch {
    // Undecryptable (ENCRYPTION_KEY rotated): nothing proven is current.
    return false;
  }
}

/** The same answer for READ paths without decrypting (display only). */
export function carrierTestLooksCurrent(row: ConnectableCarrierRow): boolean {
  const t = storedTest(row);
  if (!t?.ok || !t.fingerprint || !row.credentials) return false;
  const mode = modeOfRow(row);
  const hints = (row.credentialHints ?? {}) as CredentialHints;
  return t.mode === mode && t.fingerprint === hints.fingerprints?.[mode];
}

/** The enable gate, for EVERY write path that can leave an API carrier enabled. */
export function assertCarrierEnableAllowed(
  row: ConnectableCarrierRow,
  opts: { storeActivated?: boolean } = {}
): void {
  const entry = getProviderEntry(row.carrier);
  if (!entry || entry.kind !== 'shipping') {
    throw new AppError(422, 'UNKNOWN_CARRIER', `Unknown carrier "${row.carrier}"`);
  }
  if (entry.manual) return;
  if (!isProviderUsable(row.carrier) && !opts.storeActivated) {
    throw new AppError(
      409,
      'PROVIDER_NOT_VERIFIED',
      `${row.carrier} is not activated for this store yet: request activation first`
    );
  }
  if (!carrierTestIsCurrent(row)) {
    throw new AppError(
      409,
      'CONNECTION_NOT_TESTED',
      'Run Test connection successfully with the current credentials before enabling'
    );
  }
}

/** Run the adapter's harmless call for the row's ACTIVE mode. Never throws for carrier errors. */
export async function runCarrierConnectionTest(
  row: ConnectableCarrierRow,
  ctx: CarrierCallContext
): Promise<{
  result: { ok: boolean; code: CarrierTestCode; message: string };
  stored: StoredCarrierTest;
}> {
  const entry = carrierEntry(row.carrier);
  const mode = modeOfRow(row);
  const fields = activeFieldSet(row);
  const at = new Date().toISOString();
  const missing = missingRequiredFields(entry, fields);
  let result: { ok: boolean; code: CarrierTestCode; message: string };
  if (missing.length > 0) {
    result = { ok: false, code: 'incomplete', message: `Missing: ${missing.join(', ')}` };
  } else {
    const adapter = getCarrierAdapter(row.carrier);
    if (!adapter) {
      result = { ok: false, code: 'unknown', message: 'This carrier has no connection test' };
    } else {
      try {
        const r = await adapter.testConnection(fields, {
          ...ctx,
          settings: { ...(ctx.settings ?? {}), sandbox: mode === 'sandbox' },
        });
        result = r.success
          ? { ok: true, code: 'ok', message: 'Connected' }
          : {
              ok: false,
              code: r.code ?? 'unknown',
              // the adapter's message is already secret-free, but is a short English reason only
              message: (r.error ?? 'Connection failed').slice(0, 300),
            };
      } catch {
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
      fingerprint: result.ok ? carrierFingerprint(row.carrier, mode, fields) : null,
    },
  };
}

/**
 * The browser-safe view of a config row: no ciphertext, no fingerprint, no webhook secret.
 * Every route that returns a `shipping_carrier_configs` row returns THIS (write-only credentials).
 */
export function publicCarrierConfig<T extends Record<string, unknown>>(
  row: T
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  delete rest.credentials;
  const t = rest.connectionTest;
  const test = t && typeof t === 'object' && !Array.isArray(t) ? (t as StoredCarrierTest) : null;
  const hints: CredentialHints = { ...((rest.credentialHints ?? {}) as CredentialHints) };
  delete hints.fingerprints;
  return {
    ...rest,
    mode: row.testMode ? 'sandbox' : 'live',
    credentialHints: hints,
    connectionTest: test ? { ok: test.ok, code: test.code, mode: test.mode, at: test.at } : null,
    connectionTestCurrent: carrierTestLooksCurrent(row as unknown as ConnectableCarrierRow),
  };
}
