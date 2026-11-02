/**
 * Which requests need a LIVE identity check (Ruling NZ-D2, NEON-SCALE-1 rule 2).
 *
 * A normal request trusts the signed token claims (merchant / staff / admin access tokens live <= 5 minutes). A request
 * that changes state, or reads data that is bulk or sensitive, asks the identity service (strongly consistent) whether the
 * session is revoked and the account still exists and is active. Revocation (logout-all, password change, suspension,
 * staff removal) therefore bites immediately on every write, export and PII list, and within one token lifetime on a plain read.
 *
 * Cost if wrong (a sensitive read missing from the list): a removed or suspended staff member sees that page for <= 5 minutes.
 * Add the path here, with a test; the default for a state change is always live.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Bulk / sensitive READ areas: customer PII lists, exports, payouts, staff, billing, settings, keys, webhooks, finance. */
const SENSITIVE_READ =
  /\/(customers|exports?|payouts?|remittances?|staff|staff-invites|billing|settings|payment-settings|merchant-key|api-keys|webhooks|merchant-webhooks|finance|returns|reports|audit-logs?|mfa|passkeys?|sessions|admin)(\/|$|\?)/i;

export function needsLiveIdentity(req: {
  method: string;
  originalUrl?: string;
  url?: string;
}): boolean {
  // an unknown method is treated as a state change: the default is LIVE
  if (!SAFE_METHODS.has((req.method ?? 'POST').toUpperCase())) return true;
  const path = (req.originalUrl ?? req.url ?? '').split('#')[0];
  return SENSITIVE_READ.test(path);
}
