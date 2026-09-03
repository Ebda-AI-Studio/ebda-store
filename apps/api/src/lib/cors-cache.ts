// Shared CORS domain cache — extracted to avoid circular imports between
// index.ts (which sets up CORS) and store.routes.ts (which needs to bust the cache).
import { BoundedMap } from './bounded-map';

// Capped so a pathological stream of unknown domains (e.g. bot traffic
// probing random hostnames) can never grow the Map without limit.
export const corsDomainCache = new BoundedMap<string, { allowed: boolean; expiresAt: number }>(
  5000
);
export const CORS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Bust the CORS cache for a domain (call when a store's domain changes). */
export function bustCorsCache(domain: string): void {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  corsDomainCache.delete(normalized);
  corsDomainCache.delete(`www.${normalized}`);
}

/**
 * Platform-origin allowlist — origins WE control end-to-end. Used by:
 *   - the CORS handler (to short-circuit before the DB lookup)
 *   - the CSRF middleware to decide when the JSON-content-type skip
 *     is safe to apply.
 *
 * Custom merchant domains are NOT platform origins. They're allowed by
 * CORS via DB lookup (a merchant configures `mystore.com` and it gets
 * allowlisted), but a malicious merchant who sets `attacker.com` as
 * their store domain would have that origin allowlisted too. CSRF
 * tokens MUST still be required for JSON requests from such origins —
 * they can't be implicitly trusted just because they passed CORS.
 */
export function isPlatformOrigin(
  origin: string | undefined,
  env: { webUrl?: string; adminUrl?: string; nodeEnv: string }
): boolean {
  if (!origin) return false;

  if (env.webUrl && origin === env.webUrl) return true;
  if (env.adminUrl && origin === env.adminUrl) return true;

  // Hardcoded prod fallbacks — kept in sync with the CORS handler in
  // index.ts so a missing/forgotten env var doesn't downgrade trust.
  if (origin === 'https://store.forcemediakw.com') return true;
  if (origin === 'https://app.forcemediakw.com') return true;
  // Orders PWA (staff order-management app) — a distinct origin from admin.
  if (origin === 'https://orders.forcemediakw.com') return true;

  // force-ai.co platform origins — the 2026-06 domain rebrand (Vercel→Cloudflare
  // migration, completed 2026-07; Vercel is fully decommissioned). Mirror of the
  // forcemediakw.com platform origins above. (whatsapp[-api].force-ai.co belong
  // to the WhatsApp Bulk Sender — a different API — so they are NOT listed here.)
  if (origin === 'https://store.force-ai.co') return true;
  if (origin === 'https://admin.force-ai.co') return true;
  if (origin === 'https://orders.force-ai.co') return true;

  // Cloudflare Workers preview deploys for the project (OpenNext migration).
  // SCOPED to OUR account subdomain + our worker names — NOT any *.workers.dev,
  // which (with credentials: true) would let an attacker's worker make
  // credentialed requests to the API.
  if (
    /^https:\/\/force-(web|admin|orders)-cf-preview\.ahmed0montaser\.workers\.dev$/.test(origin)
  ) {
    return true;
  }

  // Localhost in dev.
  if (env.nodeEnv !== 'production' && origin.includes('localhost')) return true;

  return false;
}

/**
 * REMOVED 2026-09-02: `isAllowlistedMerchantOrigin`.
 *
 * It existed to let the CSRF middleware skip its token check for merchant
 * custom domains. That made every DB-registered custom domain CSRF-exempt,
 * and Cloudflare's addDomain creates a custom hostname with NO ownership
 * proof — so any merchant could register a host they control, lure a
 * logged-in super_admin to it and, because the auth cookie is SameSite=None
 * and CORS runs credentials:true, issue credentialed writes AND read the
 * responses, including a full impersonation token from POST /admin/impersonate.
 *
 * Its doc comment argued the residual threat "requires the merchant to
 * compromise their own customers via their own configured domain — outside
 * the threat model". That reasoning only considered the merchant's OWN
 * customers. It never considered another tenant's admin, or a super_admin,
 * being lured to that same domain.
 *
 * Do not reintroduce it. Guest checkout does not need it: `/public/` paths
 * return early from csrfProtection long before the origin check, and the
 * storefront client sends X-Session-ID plus X-CSRF-Token on every
 * state-changing request. Trust for the admin surface is enforced by
 * `restrictPlatformOnlyOrigins` in middleware/security.ts, which is an
 * allowlist of platform origins — not a denylist of bad ones.
 */
