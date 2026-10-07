/**
 * Drops Sentry events raised by scripts a HOST APP injects into the page —
 * never by code we ship.
 *
 * Why (FORCE-WEB-K / M / Q `RangeError: Maximum call stack size exceeded`,
 * FORCE-WEB-N / P `Error: La`, 2026-09): 63 events, 100% `Chrome Mobile iOS`,
 * zero from Mobile Safari on the same WebKit engine. Every frame of every one
 * is attributed to the DOCUMENT URL (`app:///`, `app:///products` after the
 * Next.js frame rewrite) at lines 190-464, while the served HTML is 11-12
 * lines and no `/_next/static/chunks/*.js` file we ship is longer than 51
 * lines — so no line of ours can be at 226:63. The same line:col positions
 * recur across Ebda releases two weeks apart (2214be88 → ad17d6e4), while the
 * Closure-style function names change in lockstep with the CHROME version
 * (152: Nk↔Pk, 154: Ok↔Qk). That is Chrome for iOS's own injected
 * WKUserScript, which WebKit reports under the page URL. We cannot fix it and
 * it does not break the storefront; reporting it only buries real errors.
 *
 * The filter is deliberately narrow so it can never hide a bug of ours:
 *   1. the user agent must be an iOS browser that injects WKUserScripts —
 *      Chrome/Firefox/Edge for iOS (`CriOS`/`FxiOS`/`EdgiOS`, tokens only
 *      ever sent on iOS). The evidence is 100% `CriOS`; FxiOS/EdgiOS share
 *      the same WKUserScript mechanism. Facebook/Instagram in-app browsers
 *      (`FBAN`/`FBIOS`/`Instagram`) are deliberately NOT here (issue 2008):
 *      no event evidenced them, and link-in-bio traffic through those apps
 *      is the widest-reach mobile surface of an Egypt storefront — silencing
 *      it would hide our own inline-script errors from exactly those users;
 *   2. EVERY frame must be attributed to a page path — none may come from a
 *      script file (`*.js`/`*.mjs`/`*.cjs` — every chunk we ship); AND
 *   3. EVERY frame must sit past line MIN_INJECTED_LINENO. The served HTML is
 *      11-12 lines, so an error in one of OUR inline scripts is attributed
 *      to a line no higher than that; the injected script's frames were all
 *      at 190-464. A frame with no line number keeps the event.
 * An inline-script error of ours still reports on every browser, and so does
 * anything with even one frame in a shipped chunk.
 */

// Minimal structural slice of a Sentry event — avoids importing SDK types
// into a pure, unit-testable module.
interface FrameLike {
  filename?: string;
  abs_path?: string;
  lineno?: number;
}
interface EventLike {
  exception?: { values?: Array<{ stacktrace?: { frames?: FrameLike[] } }> };
}

const HOST_INJECTING_UA = /\b(CriOS|FxiOS|EdgiOS)\//;

/**
 * Lowest line an injected-script frame may sit on. Our served documents are
 * ~12 lines (Ruling SN-1); the injected frames were at 190-464. 100 leaves a
 * wide margin on both sides — a document of ours would have to grow 8x before
 * one of its inline errors could be mistaken for the host's.
 */
const MIN_INJECTED_LINENO = 100;

function isScriptFileFrame(frame: FrameLike): boolean {
  const name = frame.filename || frame.abs_path || '';
  // No filename at all: unknown provenance — treat as ours (keep the event).
  if (!name) return true;
  let path = name;
  try {
    path = new URL(name).pathname;
  } catch {
    // Not a URL (e.g. `<anonymous>`): keep the event, provenance unknown.
    return true;
  }
  return /\.(m?js|cjs)$/i.test(path);
}

export function isHostInjectedScriptEvent(event: EventLike, userAgent: string): boolean {
  if (!HOST_INJECTING_UA.test(userAgent)) return false;
  const frames = (event.exception?.values ?? []).flatMap(v => v.stacktrace?.frames ?? []);
  if (frames.length === 0) return false;
  return frames.every(
    frame =>
      !isScriptFileFrame(frame) &&
      typeof frame.lineno === 'number' &&
      frame.lineno > MIN_INJECTED_LINENO
  );
}
