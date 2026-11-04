/**
 * Ruling SIGNIN-RETURN-1: where the sign-in page may send a person back to.
 *
 * Ebda Chat (wa.ebda.app) sends signed-out people to `accounts.ebda.app/login?product=chat&return=<url>`, which hands
 * both to the admin /login. `return` is attacker-controlled input and the page redirects the browser to it after a
 * password, MFA or passkey sign-in, so this is an open-redirect boundary: https only, host in an EXACT allowlist,
 * no userinfo, no other port, no backslash or control character, no protocol-relative or relative form.
 * Anything else is `null` and the caller uses the normal destination.
 */

/** Exact hostnames (no wildcard, no subdomain match). */
export const RETURN_HOSTS: readonly string[] = [
  'wa.ebda.app',
  'store.ebda.app',
  'orders.ebda.app',
  'ebda.app',
];

const MAX_RETURN_LENGTH = 2048;

export function safeSignInReturn(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_RETURN_LENGTH) return null;
  // Backslashes (`https:\\host`, `evil\@host`), control characters, whitespace and anything not printable ASCII-or-above:
  // browsers normalise some of these into a different host than a naive check saw.
  if (/[\\\u0000- \u007f]/.test(raw)) return null;
  // Must be written as a full https URL: this also rejects `//host`, `/path`, `host/path`, `javascript:`.
  if (!/^https:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // `URL` drops the default port, so a non-empty port is always an OTHER port.
  if (url.port) return null;
  if (!RETURN_HOSTS.includes(url.hostname)) return null;
  // The Store's own sign-in page would bounce a signed-in person straight back to itself.
  if (
    url.hostname === 'store.ebda.app' &&
    (url.pathname === '/login' || url.pathname.startsWith('/login/'))
  ) {
    return null;
  }
  return url.href;
}

export type SignInProduct = 'store' | 'chat';

/** The product the person came from. Allowlist: anything else is the Store. */
export function signInProduct(raw: string | null | undefined): SignInProduct {
  return raw === 'chat' ? 'chat' : 'store';
}
