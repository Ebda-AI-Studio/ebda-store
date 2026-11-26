/**
 * Per-request CSP nonce helpers (SEC-4 / M-067). Edge-safe: only Web Crypto + btoa, so it runs in
 * Next middleware on Cloudflare Workers and in Node alike.
 */

/** 128 random bits, base64. A new value for EVERY request, or it is forgeable. */
export function newCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Only base64 characters may reach a header (a nonce is interpolated into one). */
export function isValidCspNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && /^[A-Za-z0-9+/]{22,}={0,2}$/.test(nonce);
}

/**
 * `script-src` for an app that sets a nonce on every script it renders.
 *  - `'nonce-N' 'strict-dynamic'`: only scripts that carry the nonce, and scripts THEY load, run.
 *    Host names are then ignored by CSP3 browsers and kept only as the fallback for the few that
 *    lack strict-dynamic (the nonce is still required there for inline code).
 *  - No `'unsafe-inline'`, so an injected `<script>` or `javascript:` URL does not run.
 *  - `'unsafe-eval'` only when the caller proves it needs it.
 *  - `'wasm-unsafe-eval'` (WebAssembly only, no eval()) when the page loads a wasm decoder.
 */
export function nonceScriptSrc(
  nonce: string,
  opts: { hosts?: readonly string[]; unsafeEval?: boolean; wasmUnsafeEval?: boolean } = {}
): string {
  const parts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (opts.unsafeEval) parts.push("'unsafe-eval'");
  // WebAssembly compile only (the 3D viewer's meshopt decoder); JS eval() stays blocked.
  if (opts.wasmUnsafeEval) parts.push("'wasm-unsafe-eval'");
  parts.push(...(opts.hosts ?? []));
  return `script-src ${parts.join(' ')}`;
}
