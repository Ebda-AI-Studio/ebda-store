import { describe, it, expect } from 'vitest';
import { jsonLdScriptContent } from '../json-ld-script';

/**
 * Regression tests for the JSON-LD `</script>` break-out.
 *
 * Before the fix, JsonLd used bare `JSON.stringify`, whose output contains a
 * raw `</script>` for any string carrying one. Because the HTML tokenizer ends
 * a <script> block at the first `</script` — JSON quoting is irrelevant to it
 * — the rest of the payload was parsed as markup, and the storefront CSP
 * allows 'unsafe-inline', so an injected handler executed.
 */
describe('jsonLdScriptContent', () => {
  const BREAKOUT = '</script><img src=x onerror=alert(1)>';

  it('never emits a raw </script> for a product name', () => {
    const out = jsonLdScriptContent({ '@type': 'Product', name: `Widget ${BREAKOUT}` });
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<img');
  });

  it('escapes a customer-submitted review body and author name', () => {
    // Both fields reach productJsonLd; neither is HTML-stripped on input
    // (review body is z.string().max(5000); firstName is z.string().min(1)).
    const out = jsonLdScriptContent({
      review: [{ author: BREAKOUT, reviewBody: BREAKOUT }],
    });
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('proves bare JSON.stringify was NOT sufficient', () => {
    // Guards the disproven comment this fix replaced.
    expect(JSON.stringify({ name: BREAKOUT })).toContain('</script>');
  });

  it('round-trips back to the original value for schema.org consumers', () => {
    const data = { '@type': 'Product', name: 'A < B & C > D', desc: BREAKOUT };
    expect(JSON.parse(jsonLdScriptContent(data))).toEqual(data);
  });

  it('escapes U+2028/U+2029 line terminators', () => {
    const raw = 'a\u2028b\u2029c';
    const out = jsonLdScriptContent({ name: raw });
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(JSON.parse(out).name).toBe(raw);
  });

  it('leaves ordinary content readable', () => {
    expect(jsonLdScriptContent({ name: 'Pecan Mix' })).toBe('{"name":"Pecan Mix"}');
  });
});
