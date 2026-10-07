/**
 * Shared helper for parsing JSON responses from Gemini.
 *
 * Wraps `JSON.parse` with TWO layers of defense against the well-known
 * Gemini quirks:
 *
 *   1. **Code fences + trailing prose**: Gemini occasionally emits ```json
 *      fences or appends explanatory text after a valid JSON body even
 *      when prompted for pure JSON. `stripFences` cleans those up.
 *
 *   2. **Unescaped control characters inside string literals**: Gemini
 *      occasionally returns a JSON-looking string that contains literal
 *      newlines / tabs / CR INSIDE string values (e.g.
 *      `{"en": "Product X is...\n• Spec 1\n• Spec 2"}` with REAL `\n`
 *      bytes, not escape sequences). `JSON.parse` throws
 *      `Bad control character in string literal in JSON at position N`
 *      on those. `sanitizeJsonControlChars` walks the string tracking
 *      whether we're inside a `"..."` literal and escapes control chars
 *      ONLY in that context — outside strings, JSON allows raw whitespace.
 *
 * Use `parseAiJson(rawText)` everywhere `JSON.parse(stripFences(raw))`
 * was previously used (4 sites as of 2026-05-28: bulk-ai-aeo,
 * bulk-ai-geo (citation-copy + brand-facts), bulk-ai-recommendations,
 * services/ai.service.ts).
 *
 * Reference: Palestinian zatar citation-copy product on Demo Shop
 * triggered "Bad control character in string literal in JSON at
 * position 147" on 2026-05-28. The Gemini body had real newlines
 * between the bullet points the prompt asks for.
 */

/**
 * Strip Markdown code fences + extract the outermost JSON span.
 *
 * Gemini occasionally appends prose after a valid JSON body even when
 * prompted for pure JSON. Slice from the first `{`/`[` to the last
 * matching `}`/`]`.
 */
function stripFences(text: string): string {
  let s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const firstOpen = s.search(/[\{\[]/);
  if (firstOpen > 0) s = s.slice(firstOpen);

  const lastClose = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastClose !== -1 && lastClose < s.length - 1) {
    s = s.slice(0, lastClose + 1);
  }

  return s;
}

/**
 * Escape literal control characters (newline / tab / CR / form-feed /
 * backspace / vertical-tab / NUL .. US) that appear INSIDE JSON string
 * literals. JSON spec forbids U+0000..U+001F bytes inside strings — they
 * must be escaped as `\n` / `\t` / `\uXXXX` etc.
 *
 * Walks character-by-character tracking string-literal state so we don't
 * accidentally escape control chars between tokens (which JSON allows
 * as whitespace).
 */
export function sanitizeJsonControlChars(s: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // Inside an escape sequence — pass the char through verbatim. The
    // previous iteration already wrote the leading `\`. Reset the flag.
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    // `\` inside a string starts an escape sequence. Outside a string
    // it's invalid JSON, but pass through so the eventual parse error
    // surfaces the real problem rather than us masking it.
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        // Control char — escape it.
        switch (ch) {
          case '\n':
            result += '\\n';
            break;
          case '\r':
            result += '\\r';
            break;
          case '\t':
            result += '\\t';
            break;
          case '\b':
            result += '\\b';
            break;
          case '\f':
            result += '\\f';
            break;
          default:
            // Anything else in U+0000..U+001F → \uXXXX form
            result += '\\u' + code.toString(16).padStart(4, '0');
        }
        continue;
      }
    }

    result += ch;
  }

  return result;
}

/**
 * Parse a raw Gemini response as JSON, applying both stripFences AND
 * sanitizeJsonControlChars before JSON.parse. The combination handles
 * every observed Gemini quirk class as of 2026-05-28.
 *
 * Throws if the result still isn't valid JSON.
 */
export function parseAiJson<T = unknown>(rawText: string): T {
  const stripped = stripFences(rawText);
  const sanitized = sanitizeJsonControlChars(stripped);
  return JSON.parse(sanitized) as T;
}
