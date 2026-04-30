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

  // Vercel preview / production deployments for the project (strict
  // prefix match, same regex as the CORS handler).
  if (
    origin.endsWith('.vercel.app') &&
    (/^https:\/\/force-web(-[a-z0-9]+)?\.vercel\.app$/.test(origin) ||
      /^https:\/\/force-admin(-[a-z0-9]+)?\.vercel\.app$/.test(origin))
  ) {
    return true;
  }

  // Localhost in dev.
  if (env.nodeEnv !== 'production' && origin.includes('localhost')) return true;

  return false;
}
