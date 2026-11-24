/**
 * The platform-global InstaPay duplicate index (Ruling INSTAPAY-AUTO-1, foundation `instapay-dedupe`): ONE D1 `ebda-instapay-dedupe`
 * bound as `INSTAPAY_DEDUPE_DB` in Store and Chat, so a receipt (reference + image hash) can pay once across every merchant AND both products.
 * Missing binding -> `getDuplicateIndex()` is null and the caller forces `needs_human` (FAIL CLOSED: no index, no automatic activation).
 */
import { D1DuplicateIndex, type DuplicateIndex, type DedupeD1Like } from '@ebda/shared';
import { cfBindings } from '../cf/bindings';
import { instapayHandle } from '../services/billing/manual-config';
import { MIN_BRIDGE_SECRET } from './instapay-bridge-env';

export function getDuplicateIndex(): DuplicateIndex | null {
  const db = (cfBindings() as { INSTAPAY_DEDUPE_DB?: DedupeD1Like } | undefined)
    ?.INSTAPAY_DEDUPE_DB;
  return db ? new D1DuplicateIndex(db) : null;
}

/** What auto-confirm needs to run at all; listed on /health as `instapayAuto`. Reported, never a reason to fail a deploy (the mode is `off`). */
export function instapayAutoReady(env: Record<string, string | undefined> = process.env): {
  ready: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!getDuplicateIndex()) missing.push('INSTAPAY_DEDUPE_DB');
  if (!instapayHandle(env)) missing.push('EBDA_INSTAPAY_HANDLE');
  if ((env.INSTAPAY_BRIDGE_SECRET ?? '').length < MIN_BRIDGE_SECRET)
    missing.push('INSTAPAY_BRIDGE_SECRET');
  if (!(env.BRAIN_BRIDGE_URL ?? '').trim()) missing.push('BRAIN_BRIDGE_URL');
  return { ready: missing.length === 0, missing };
}
