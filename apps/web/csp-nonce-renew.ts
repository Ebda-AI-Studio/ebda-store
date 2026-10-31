import { newCspNonce } from '@ebda/shared';

/**
 * Per-response CSP nonce for HTML served from the worker's edge caches (Ruling CSP-WEB-1).
 *
 * A cached page was rendered with ONE nonce, written in its CSP header, in every `nonce="..."` attribute and in
 * the flight payload. Served as is, every visitor would get the same value, readable by anyone who fetched the
 * page, so it would no longer stop an injected script. `renewNonce` gives each response its own: it mints a fresh
 * nonce and replaces the old one, as a plain string, in the CSP header AND throughout the streamed body (attribute
 * values and the RSC payload alike), so the header and the page always agree and the stored copy is never touched.
 * The old nonce is 128 random bits, so it cannot occur in the page by accident. The length never changes, which
 * keeps the stream a pure substitution (a match split across two chunks is handled by holding back the tail).
 */
export function nonceOfCsp(csp: string | null): string | null {
  return csp ? (/'nonce-([^']+)'/.exec(csp)?.[1] ?? null) : null;
}

function replacingStream(from: string, to: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = '';
  const hold = from.length - 1;
  return new TransformStream({
    transform(chunk, controller) {
      // Replace first, then hold back the last `hold` characters: a match cut by the chunk edge is completed by
      // the next chunk, and nothing already replaced can match again (the fresh value differs from the old).
      const text = (carry + decoder.decode(chunk, { stream: true })).split(from).join(to);
      const cut = Math.max(0, text.length - hold);
      carry = text.slice(cut);
      if (cut > 0) controller.enqueue(encoder.encode(text.slice(0, cut)));
    },
    flush(controller) {
      const rest = carry + decoder.decode();
      if (rest) controller.enqueue(encoder.encode(rest.split(from).join(to)));
    },
  });
}

/** A copy of `res` carrying a fresh nonce; `res` itself is returned unchanged when it has no nonce policy. */
export function renewNonce(res: Response, fresh: string = newCspNonce()): Response {
  const csp = res.headers.get('content-security-policy');
  const old = nonceOfCsp(csp);
  if (!csp || !old || !res.body) return res;
  const out = new Response(res.body.pipeThrough(replacingStream(old, fresh)), res);
  out.headers.set('content-security-policy', csp.split(old).join(fresh));
  out.headers.delete('content-length');
  return out;
}
