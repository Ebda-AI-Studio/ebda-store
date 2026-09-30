/**
 * The admin-i18n hardcoded-string heuristic, shared by
 * tests/unit/admin-i18n-no-hardcoded-strings.test.ts (the guard) and nothing
 * else — kept out of the test file so the widened passes below can be read,
 * and their known-debt snapshot regenerated, from one definition.
 *
 * TWO tiers:
 *   - STRICT (the original B2 heuristic): a JSX text node made of plain
 *     letters/punctuation, and a double-quoted chrome attribute. Any hit not
 *     allowlisted fails.
 *   - WIDENED (issue 2182): the shapes STRICT is blind to, each proven by a
 *     real string in the covered files —
 *       * text containing digits, `→`, `—`, `%`, `"` …   `<p>… Finance → Journal.</p>`
 *       * a chrome attribute written as an expression     `title={'…'}`
 *       * a capitalised string literal in a ternary        `{busy ? 'Receiving…' : t('x')}`
 *       * a chrome-named object property                   `header: 'Product'`
 *     A widened hit fails unless it is allowlisted OR recorded in the
 *     known-debt snapshot (admin-i18n-known-debt.json) — a ratchet: the
 *     debt can only shrink, and any NEW string in these shapes goes red.
 * Still NOT seen (stated so no reader over-trusts the guard): template
 * literals, text bounded by an interpolation on both sides (`{n} rows`),
 * lower-case ternary literals, and any string outside the 81 listed files.
 */

const JSX_TEXT_REGEX = />\s*([A-Za-z][A-Za-z ,.'!?:()&/-]{2,}?)\s*</g;
const CHROME_ATTR_REGEX = /\b(?:placeholder|title|aria-label|label|alt)="([^"]{2,})"/g;

const WIDE_TEXT_REGEX = />\s*([A-Za-z][^<>{}=;]{2,}?)\s*</g;
const ATTR_EXPR_REGEX = /\b(?:placeholder|title|aria-label|label|alt)=\{\s*'([^']{3,})'\s*\}/g;
const TERNARY_LITERAL_REGEX = /[?:]\s*'([A-Z][a-z][^']+)'\s*(?=[:)}\]])/g;
const CHROME_PROP_REGEX = /\b(?:header|label|title|placeholder|ariaLabel)\s*:\s*'([^']{3,})'/g;

function collect(rx: RegExp, src: string, minLen: number): string[] {
  const out: string[] = [];
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src))) {
    const inner = m[1].trim();
    if (inner.length >= minLen) out.push(inner);
  }
  return out;
}

/** Collapse all whitespace so prettier-wrapped JSX text matches (#1934). */
const normalize = (source: string) => source.replace(/\s+/g, ' ');

/** STRICT tier — the original B2 heuristic, unchanged. */
export function findHardcodedHits(source: string, allow: ReadonlySet<string>): string[] {
  const s = normalize(source);
  return [
    ...collect(JSX_TEXT_REGEX, s, 3)
      .filter(t => !allow.has(t))
      .map(t => `[text] ${t}`),
    ...collect(CHROME_ATTR_REGEX, s, 2)
      .filter(t => !allow.has(t))
      .map(t => `[attr] ${t}`),
  ];
}

/** WIDENED tier (issue 2182) — excludes anything STRICT already reports. */
export function findWidenedHits(source: string, allow: ReadonlySet<string>): string[] {
  const s = normalize(source);
  const strictText = new Set(collect(JSX_TEXT_REGEX, s, 3));
  const out = [
    ...collect(WIDE_TEXT_REGEX, s, 3)
      .filter(t => !strictText.has(t))
      .map(t => `[text+] ${t}`),
    ...collect(ATTR_EXPR_REGEX, s, 3).map(t => `[attr-expr] ${t}`),
    ...collect(TERNARY_LITERAL_REGEX, s, 3).map(t => `[ternary] ${t}`),
    ...collect(CHROME_PROP_REGEX, s, 3).map(t => `[prop] ${t}`),
  ];
  return out.filter(h => !allow.has(h.slice(h.indexOf(' ') + 1)));
}
