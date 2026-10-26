/**
 * Which URLs count as "our media" (SEC-6 / M-130).
 *
 * Store logo / ogImage URLs are merchant-controlled and some server-side code (the OG card
 * renderer) fetches or embeds them, so they must point at the media origin we serve uploads
 * from, never at an arbitrary host. Allowed: https on the R2 public domain (`*.r2.dev`), the
 * Ebda media custom domain, and the deployment's own `STORAGE_PUBLIC_URL` host when given.
 * Pure, no I/O.
 */
export const EBDA_MEDIA_HOSTS: readonly string[] = ['media.ebda.app'];

export function isEbdaMediaUrl(raw: unknown, extraOrigin?: string | null): boolean {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (EBDA_MEDIA_HOSTS.includes(host)) return true;
  if (extraOrigin) {
    try {
      const e = new URL(extraOrigin);
      if (e.protocol === 'https:' && e.hostname.toLowerCase() === host) return true;
    } catch {
      /* unusable extra origin: ignore */
    }
  }
  return false;
}
