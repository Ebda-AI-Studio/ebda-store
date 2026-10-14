/**
 * Platform / browser detection utilities.
 *
 * NOTE: these functions read `navigator` — they must only be called in
 * browser contexts (client components, event handlers, useEffect, etc.).
 * All functions guard against `typeof navigator === 'undefined'` for SSR.
 *
 * @ebda/shared targets Node + Browser runtimes; the DOM lib is not included
 * in the tsconfig so we access the browser globals through `globalThis` (which
 * is available in both runtimes without needing lib: ["DOM"]).
 */

/**
 * Returns true on iOS/iPadOS Safari/WebKit — the only browsers where the
 * cross-origin httpOnly auth cookie is unreliable for installed PWAs (ITP
 * purges it). On all other browsers (desktop Chrome/Firefox, Android Chrome)
 * the httpOnly cookie carries the session and the refresh token must NOT be
 * persisted to localStorage (JS-readable, XSS exposure).
 *
 * Detection logic:
 *  - Classic iOS: /iP(hone|ad|od)/i in the UA
 *  - iPadOS 13+ desktop-mode: navigator.platform === 'MacIntel' with
 *    maxTouchPoints > 1 (Apple's own documented fingerprint for this case)
 */
export function isIosWebkit(): boolean {
  // Access navigator through globalThis so this compiles under the Node-only
  // tsconfig (lib: ['ES2022'], no DOM) while still working in browsers.
  const nav = (globalThis as Record<string, unknown>)['navigator'] as
    | { userAgent?: string; platform?: string; maxTouchPoints?: number }
    | undefined;
  if (!nav) return false;
  if (nav.userAgent && /iP(hone|ad|od)/i.test(nav.userAgent)) return true;
  // iPadOS 13+ desktop-mode fingerprint (Apple's documented detection)
  if (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1) return true;
  return false;
}
