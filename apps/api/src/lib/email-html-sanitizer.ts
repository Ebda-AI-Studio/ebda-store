/**
 * Minimal, dependency-free HTML sanitizer for merchant-composed newsletter
 * broadcasts.
 *
 * The newsletter composer accepts raw HTML so merchants can apply basic
 * formatting (bold, links, lists, images). Without sanitization a careless or
 * malicious admin could embed `<script>`, tracking iframes, or `javascript:`
 * links and blast them to every subscriber. Email clients strip most active
 * content, but webmail previews and the admin-side preview can still execute
 * it — and we never want to relay a phishing-grade payload through our sender
 * reputation.
 *
 * This is NOT a full HTML5 parser. It's a conservative allowlist pass that:
 *   1. removes dangerous *elements* whole, including their content
 *      (script / style / iframe / object / embed / link / meta / base / form /
 *      svg / math), and
 *   2. strips `on*` event-handler attributes and neutralizes
 *      `javascript:` / `vbscript:` / `data:` (non-image) URLs in href/src.
 *
 * The repo has no `sanitize-html` / `isomorphic-dompurify` runtime dependency
 * (`dompurify` is transitive only and needs a DOM), so a hand-rolled pass —
 * matching the existing `pages.service.ts` "escape + URL allowlist" approach —
 * is the pragmatic, no-new-dep choice. Keep it strict: when in doubt, drop.
 */

// Elements removed together with everything they contain. These either execute
// code, load external active content, or define document-level behavior that
// has no place in an email body.
const FORBIDDEN_ELEMENTS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
  'noscript',
  'template',
];

/**
 * Strip ASCII control characters (0x00–0x1F, 0x7F) from a string. Browsers /
 * mail clients strip TAB/LF/CR when resolving a URL, so `java\tscript:` would
 * otherwise slip past a scheme test. Implemented via char codes so the source
 * carries no literal control bytes.
 */
function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    out += value[i];
  }
  return out;
}

function stripForbiddenElements(html: string): string {
  let out = html;
  for (const tag of FORBIDDEN_ELEMENTS) {
    // Paired tag + content (non-greedy, case-insensitive, dot-matches-newline).
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    out = out.replace(paired, '');
    // Any stray self-closing / unclosed opening tag of the same name.
    const lone = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    out = out.replace(lone, '');
  }
  return out;
}

// Strip `on*` event-handler attributes (onclick, onerror, onload, …) in both
// quoted and unquoted forms.
function stripEventHandlers(html: string): string {
  return html
    .replace(/\son[a-z-]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z-]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z-]+\s*=\s*[^\s>]+/gi, '');
}

const DANGEROUS_SCHEME_RE = /^(javascript|vbscript):/i;
const DATA_NON_IMAGE_RE = /^data:(?!image\/)/i;

// Neutralize dangerous URL schemes in href/src/srcset/xlink:href attributes.
// `data:image/...` is allowed (inline images are common + safe in email);
// every other `data:` plus `javascript:`/`vbscript:` is replaced with `#`.
function neutralizeUrlAttributes(html: string): string {
  return html.replace(
    /\s(href|src|srcset|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, attr: string, _raw: string, dq?: string, sq?: string, uq?: string) => {
      const value = dq ?? sq ?? uq ?? '';
      // Decode common entity/whitespace/control obfuscation before testing.
      const probe = stripControlChars(value.replace(/&#[xX]?[0-9a-fA-F]+;?/g, '')).replace(
        /\s+/g,
        ''
      );
      if (DANGEROUS_SCHEME_RE.test(probe) || DATA_NON_IMAGE_RE.test(probe)) {
        return ` ${attr}="#"`;
      }
      return match;
    }
  );
}

const DANGEROUS_STYLE_RE =
  /expression\s*\(|javascript:|vbscript:|@import|url\s*\(\s*['"]?\s*(javascript|vbscript):/i;

// Inline `style` attributes survive the <style>-block removal, so strip any
// that smuggle `expression()` / `javascript:` / `@import`.
function stripDangerousInlineStyles(html: string): string {
  return html.replace(
    /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, _raw: string, dq?: string, sq?: string) => {
      const value = stripControlChars(dq ?? sq ?? '');
      return DANGEROUS_STYLE_RE.test(value) ? '' : match;
    }
  );
}

/**
 * Sanitize merchant-composed newsletter HTML. Returns a string safe to wrap in
 * the branded email shell and relay to subscribers. Basic formatting tags
 * (`<b>`, `<p>`, `<a>`, `<ul>`, `<img>`, …) survive; active/dangerous content
 * is removed.
 */
export function sanitizeNewsletterHtml(html: string): string {
  if (!html) return '';
  let out = stripForbiddenElements(html);
  out = stripEventHandlers(out);
  out = neutralizeUrlAttributes(out);
  out = stripDangerousInlineStyles(out);
  return out;
}
