/**
 * P0 logout audit (2026-11-03): a revoked session (password changed, signed out on another device) used to end as a
 * burst of failing calls and a silent logout. Now it ends once, with a calm message on /login and the page the person
 * was on as a same-origin `returnTo`.
 */
import { PUBLIC_PATHS } from './public-paths';

export const SESSION_ENDED_KEY = 'ebda.sessionEnded';

/** Same-origin absolute path only: no scheme, no `//host`, no backslash, no control characters, not the login page. */
function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = raw.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (PUBLIC_PATHS.includes(path)) return null;
  return raw;
}

export function buildSessionEndedUrl(returnPath: string | null | undefined): string {
  const safe = safeReturnPath(returnPath);
  return safe ? `/login?returnTo=${encodeURIComponent(safe)}&ended=1` : '/login?ended=1';
}

let redirecting = false;

export interface EndedLocation {
  pathname: string;
  search: string;
  assign: (url: string) => void;
}

/** End the session visibly. Idempotent; a no-op on public pages, where nobody was signed in. */
export function handleSessionEnded(
  loc: EndedLocation | undefined = typeof window === 'undefined'
    ? undefined
    : {
        pathname: window.location.pathname,
        search: window.location.search,
        assign: u => window.location.assign(u),
      }
): void {
  if (!loc || redirecting) return;
  const path = loc.pathname.replace(/\/+$/, '') || '/';
  if (PUBLIC_PATHS.includes(path)) return;
  redirecting = true;
  try {
    window.sessionStorage.setItem(SESSION_ENDED_KEY, '1');
  } catch {
    // storage blocked: the ?ended=1 query still carries the message
  }
  loc.assign(buildSessionEndedUrl(`${loc.pathname}${loc.search}`));
}

/**
 * TEN-4: a credential-class change (keys, staff, provider credentials) answered 403 STEP_UP_REQUIRED because the sign-in is
 * older than 30 minutes. End the session at the identity service (best effort) and send the person to /login with the page as
 * `returnTo`; a fresh sign-in is the step-up. Idempotent, no-op on public pages.
 */
export async function handleStepUpRequired(
  signOut: () => Promise<unknown>,
  loc: EndedLocation | undefined = typeof window === 'undefined'
    ? undefined
    : {
        pathname: window.location.pathname,
        search: window.location.search,
        assign: u => window.location.assign(u),
      }
): Promise<void> {
  if (!loc || redirecting) return;
  const path = loc.pathname.replace(/\/+$/, '') || '/';
  if (PUBLIC_PATHS.includes(path)) return;
  redirecting = true;
  await signOut().catch(() => undefined);
  const safe = safeReturnPath(`${loc.pathname}${loc.search}`);
  loc.assign(safe ? `/login?returnTo=${encodeURIComponent(safe)}&stepup=1` : '/login?stepup=1');
}

/** Read-once flag the login page uses to show the "session ended" note. */
export function consumeSessionEnded(): boolean {
  try {
    const v = window.sessionStorage.getItem(SESSION_ENDED_KEY);
    window.sessionStorage.removeItem(SESSION_ENDED_KEY);
    return v === '1';
  } catch {
    return false;
  }
}
