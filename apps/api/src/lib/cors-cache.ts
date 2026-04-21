// Shared CORS domain cache — extracted to avoid circular imports between
// index.ts (which sets up CORS) and store.routes.ts (which needs to bust the cache).

export const corsDomainCache = new Map<string, { allowed: boolean; expiresAt: number }>();
export const CORS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Bust the CORS cache for a domain (call when a store's domain changes). */
export function bustCorsCache(domain: string): void {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  corsDomainCache.delete(normalized);
  corsDomainCache.delete(`www.${normalized}`);
}
