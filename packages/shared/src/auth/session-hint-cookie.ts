/**
 * The admin / orders "looks signed in" hint cookie (a UX hint, never auth).
 * Written as `ebda-session`; the pre-rename cookie is still read and cleared so
 * a deploy does not bounce signed-in merchants.
 *
 * TODO(2026-12-01): delete LEGACY_SESSION_HINT_COOKIE and its uses, then drop
 * this file from tests/unit/branding-allowlist.json.
 */
export const LEGACY_SESSION_HINT_REMOVE_AFTER = '2026-12-01';
export const SESSION_HINT_COOKIE = 'ebda-session';
const LEGACY_SESSION_HINT_COOKIE = 'force-session';

/** True when `document.cookie` carries the hint under the new or the legacy name. */
export function hasSessionHintCookie(cookie: string): boolean {
  return [SESSION_HINT_COOKIE, LEGACY_SESSION_HINT_COOKIE].some(name =>
    new RegExp(`(?:^|;\\s*)${name}=1(?:;|$)`).test(cookie)
  );
}

/** `document.cookie` assignment that sets the hint (new name only). */
export function sessionHintCookieSet(maxAgeSeconds: number): string {
  return `${SESSION_HINT_COOKIE}=1; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

/** `document.cookie` assignments that expire the hint under BOTH names. */
export function sessionHintCookieClears(): string[] {
  return [SESSION_HINT_COOKIE, LEGACY_SESSION_HINT_COOKIE].map(
    name => `${name}=; path=/; max-age=0`
  );
}
