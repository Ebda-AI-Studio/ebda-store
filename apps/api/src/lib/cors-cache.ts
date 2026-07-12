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
 * True when the origin is currently allowlisted in the CORS domain cache
 * as a merchant custom domain. Used by the CSRF middleware's JSON-skip
 * decision so guest checkout / cart / review POSTs from a real merchant
 * storefront (e.g. `wadyaljuz.com`) aren't rejected as CSRF_MISSING_SESSION.
 *
 * Safety: CORS preflight already verified this domain is configured by a
 * real merchant in the DB. Guest checkout endpoints don't read any session
 * cookie (so cookie-riding CSRF can't apply), and signed-in mutations use
 * Bearer tokens which short-circuit CSRF earlier in the middleware. The
 * residual threat (malicious merchant sets `attacker.com` as their store
 * domain, then redirects victim's storefront to it) requires the merchant
 * to compromise their own customers via their own configured domain —
 * outside the threat model the platform protects against.
 *
 * Returns false when:
 *   - origin missing / empty
 *   - origin not in the cache (cold cache; CORS handler will populate on
 *     the same request and a refresh will succeed — extremely rare in
 *     practice because the storefront fetches store config first)
 *   - origin present but `allowed: false` (DB lookup explicitly rejected)
 *   - cache entry expired
 */
export function isAllowlistedMerchantOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const entry = corsDomainCache.get(host);
  if (!entry || !entry.allowed) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}
