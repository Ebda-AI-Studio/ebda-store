/**
 * Owner consent gate (Ruling CONSENT-ADMIN-1). A store owner with NO acceptance record of the Terms or
 * the Privacy policy (staff-invited, or older than the click-wrap) must accept affirmatively before the
 * admin writes anything. Reads, login, the storefront and customers' orders are never blocked.
 *
 * Enforced server-side in `authenticate` (a UI modal alone is bypassable): a non-GET request by a
 * `store_admin` answers 403 CONSENT_REQUIRED until `consentGiven(userId)`. Material CHANGES to documents
 * already accepted stay on the notice banner, so only the "never accepted" case lands here.
 *
 * Cache: only a positive answer is remembered. An acceptance is never withdrawn by the app (erasure deletes
 * the user), so a cached `true` cannot go stale; a negative is re-read every time so accepting takes effect
 * on the next request, on every isolate.
 */
import { prisma } from '@ebda/database';
import { withPlatformUser } from './platform-scope';

/** The documents an owner must have accepted (at any version) before admin writes. */
const CONSENT_DOC_KEYS = ['terms', 'privacy'] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Never gated: signing in/out, MFA, and the consent + notice endpoints themselves. */
const EXEMPT = [/^\/api\/v1\/auth(\/|$)/, /^\/api\/v1\/me\/legal-notices(\/|$)/];

const accepted = new Set<string>();
const MAX_CACHED = 5000;

/** Tests, and a defence for ops: `OWNER_CONSENT_GATE=0` switches the gate off, `=1` forces it on under test. */
export function ownerConsentGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OWNER_CONSENT_GATE === '1') return true;
  if (env.OWNER_CONSENT_GATE === '0') return false;
  return env.NODE_ENV !== 'test';
}

/** True when the request is a write the gate applies to (path without query). */
export function isGatedRequest(method: string, originalUrl: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const path = originalUrl.split('?')[0] ?? '';
  return !EXEMPT.some(re => re.test(path));
}

export async function consentGiven(userId: string): Promise<boolean> {
  if (accepted.has(userId)) return true;
  const rows = await withPlatformUser(userId, () =>
    prisma.legalAcceptance.findMany({
      where: { userId, docKey: { in: [...CONSENT_DOC_KEYS] } },
      select: { docKey: true },
    })
  );
  const have = new Set(rows.map(r => r.docKey));
  const ok = CONSENT_DOC_KEYS.every(k => have.has(k));
  if (ok) {
    if (accepted.size >= MAX_CACHED) accepted.clear();
    accepted.add(userId);
  }
  return ok;
}
