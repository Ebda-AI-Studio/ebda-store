/**
 * Safe serialization for `<script type="application/ld+json">` payloads.
 *
 * WHY THIS EXISTS — `JSON.stringify` alone is NOT safe here.
 *
 * The previous JsonLd component carried a comment claiming "JSON.stringify
 * escapes every special HTML character that could constitute a script
 * injection vector". That is false. `JSON.stringify` escapes quotes and
 * backslashes, but it emits `<` and `>` verbatim:
 *
 *   JSON.stringify({ name: 'a</script><img src=x onerror=alert(1)>' })
 *   // → {"name":"a</script><img src=x onerror=alert(1)>"}
 *
 * Inside a `<script>` element the HTML tokenizer ends the block at the first
 * `</script` sequence regardless of JSON string quoting, so the remainder is
 * parsed as markup and executes. The storefront CSP allows `'unsafe-inline'`
 * for script-src, so an injected inline handler runs.
 *
 * This matters because JSON-LD payloads carry attacker-reachable text:
 * product names/descriptions (merchant + bulk supplier import), FAQ entries,
 * customer-submitted review bodies, and review author names taken from a
 * self-registered customer's firstName/lastName. None of those are
 * HTML-stripped on input (review body is `z.string().max(5000)`).
 *
 * Escaping `<`, `>` and `&` as `\uXXXX` keeps the document valid JSON — the
 * escapes decode back to the original characters for schema.org consumers
 * (Google, Bing) — while making a `</script>` break-out impossible. U+2028
 * and U+2029 are also escaped: they are legal in JSON strings but are line
 * terminators in JavaScript, so they break any consumer that evaluates the
 * block as JS rather than parsing it.
 */
export function jsonLdScriptContent(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
