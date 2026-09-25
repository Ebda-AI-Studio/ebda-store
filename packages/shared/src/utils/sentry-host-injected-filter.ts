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
 * recur across FWB releases two weeks apart (2214be88 → ad17d6e4), while the
 * Closure-style function names change in lockstep with the CHROME version
 * (152: Nk↔Pk, 154: Ok↔Qk). That is Chrome for iOS's own injected
 * WKUserScript, which WebKit reports under the page URL. We cannot fix it and
 * it does not break the storefront; reporting it only buries real errors.
 *
 * The filter is deliberately narrow so it can never hide a bug of ours:
 *   1. the user agent must be an iOS host app that injects scripts
 *      (Chrome/Firefox/Edge for iOS, Facebook/Instagram in-app browsers), AND
 *   2. EVERY frame must be attributed to a page path — none may come from a
 *      script file (`*.js`/`*.mjs`/`*.cjs` — every chunk we ship).
 * An inline-script error of ours on Safari, Android or desktop still reports,
 * and so does anything with even one frame in a shipped chunk.
 */

// Minimal structural slice of a Sentry event — avoids importing SDK types
// into a pure, unit-testable module.
interface FrameLike {
  filename?: string;
  abs_path?: string;
}
interface EventLike {
  exception?: { values?: Array<{ stacktrace?: { frames?: FrameLike[] } }> };
}

const HOST_INJECTING_UA = /\b(CriOS|FxiOS|EdgiOS|FBAN|FBIOS|Instagram)\b/;

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
  return frames.every(frame => !isScriptFileFrame(frame));
}
