/**
 * Legal policy acceptance and material-change notices (Ruling LEGAL-4).
 *
 * Versions come from LEGAL_POLICIES (@ebda/shared). This service records acceptance
 * (signup click-wrap, dashboard "Got it"), computes which notices a merchant still has to
 * see, and runs the email fan-out the super-admin "Send notice" starts.
 *
 * Staleness class of the pending-notice read: NEVER-stale. It is computed per request and
 * never cached (no Redis/KV/bounded-map, `Cache-Control: no-store` on the route), so ack
 * and send need no invalidation.
 */
import {
  LEGAL_DOC_KEYS,
  LEGAL_POLICIES,
  currentLegalVersion,
  type LegalDocKey,
  type LegalPolicies,
} from '@ebda/shared';

/** Longest user-agent stored on an acceptance row. */
export const LEGAL_UA_MAX = 512;

/** Cut at a code-point boundary so a surrogate pair is never split. */
function truncateByCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join('');
}

export type LegalAcceptanceSource = 'signup' | 'notice_ack';

let activePolicies: LegalPolicies = LEGAL_POLICIES;

/** The registry in force (the shipped LEGAL_POLICIES outside tests). */
export function activeLegalPolicies(): LegalPolicies {
  return activePolicies;
}

/** Tests only: run against a fixture registry (e.g. one with a material version). `null` restores. */
export function __setLegalPoliciesForTests(p: LegalPolicies | null): void {
  activePolicies = p ?? LEGAL_POLICIES;
}

/**
 * The ONE place an acceptance row is shaped (user-agent truncation, null for absent
 * ip/UA). Signup click-wrap and the dashboard ack both build their rows with it.
 */
export function buildAcceptanceRow(
  userId: string,
  docKey: LegalDocKey,
  version: string,
  source: LegalAcceptanceSource,
  request: { ip?: string; userAgent?: string },
  now: Date = new Date()
) {
  return {
    userId,
    docKey,
    version,
    acceptedAt: now,
    ip: request.ip ?? null,
    userAgent: request.userAgent ? truncateByCodePoints(request.userAgent, LEGAL_UA_MAX) : null,
    source,
  };
}

/** The click-wrap rows for a new account: every document at its CURRENT version. */
export function signupAcceptanceRows(
  userId: string,
  request: { ip?: string; userAgent?: string },
  now: Date = new Date()
) {
  return LEGAL_DOC_KEYS.map(docKey =>
    buildAcceptanceRow(
      userId,
      docKey,
      currentLegalVersion(activePolicies, docKey).version,
      'signup',
      request,
      now
    )
  );
}
