/**
 * The emailed `/<page>?email=…#code=…` links (reset password, verify email): read the address and the 6 digit code ONCE,
 * take them out of the address bar, and keep them for the rest of this visit.
 *
 * Why outside the component: cleaning the address bar goes through Next's patched `history.replaceState` (on purpose, so
 * the router adopts the clean URL and never writes `?email=` back), and the router then re-creates the page for the new
 * URL. The fresh instance reads an already-clean URL; a page that kept the code only in its own state decided "link
 * invalid" with no request made, on the merchant's first keystroke (2026-11-18, live on store.ebda.app/reset-password).
 *
 * A capture is bound to its page and to the history entry it was read on (`history.length`): a remount reuses it, a new
 * visit (a navigation pushes an entry) does not. `forgetEmailedLink` drops it after a success or a used/expired code.
 */
const CODE_SHAPE = /^\d{6}$/;

type Link = { email: string; code: string };
const captured = new Map<string, Link & { entry: number }>();

export function takeEmailedLink(): Link | null {
  const page = window.location.pathname;
  const email = new URLSearchParams(window.location.search).get('email') ?? '';
  const code = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code') ?? '';
  if (CODE_SHAPE.test(code) && email)
    captured.set(page, { email, code, entry: window.history.length });
  else if (captured.get(page)?.entry !== window.history.length) captured.delete(page);
  if (window.location.search || window.location.hash) window.history.replaceState(null, '', page);
  const hit = captured.get(page);
  return hit ? { email: hit.email, code: hit.code } : null;
}

export function forgetEmailedLink(page = window.location.pathname): void {
  captured.delete(page);
}
