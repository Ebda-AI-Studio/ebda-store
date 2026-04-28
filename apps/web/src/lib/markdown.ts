/**
 * Tiny hand-rolled markdown renderer for the storefront Pages CMS.
 *
 * Why hand-rolled: the spec for this app forbids new client-side
 * dependencies for what amounts to a static-content renderer. We only
 * need a small subset of CommonMark: headings (h1-h3), paragraphs,
 * bold (**), italic (*), inline links, unordered (- ) and ordered (1. )
 * lists, and line breaks. Anything beyond that falls through as escaped
 * plain text.
 *
 * Security: ALL HTML output is built from escaped fragments. The only
 * raw HTML the renderer emits is the small fixed set of tags it
 * generates itself (h1/h2/h3/p/strong/em/a/ul/ol/li/br). User input
 * never reaches the DOM verbatim — it is split into tokens, each token
 * type emits a known-safe wrapper around HTML-escaped content. URL
 * inputs in [text](url) are restricted to http(s)/mailto/tel/relative
 * paths so a malicious `javascript:` href cannot sneak through.
 *
 * Returned string is intended for `dangerouslySetInnerHTML`. Tests
 * should round-trip canonical CommonMark fixtures and verify XSS
 * payloads (img onerror, javascript: URLs, raw script tags) are
 * neutralized.
 */

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] || ch);
}

/** Allow only protocols we control. Reject javascript:, data:, etc. */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '#';
  if (/^(\/|#|\?|\.\/|\.\.\/)/.test(trimmed)) return escapeHtml(trimmed);
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return escapeHtml(trimmed);
  return '#';
}

/** Inline transformations applied after the line is HTML-escaped. */
function renderInline(line: string): string {
  let out = escapeHtml(line);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

type Block =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { type: 'ul' | 'ol'; items: string[] };

export function renderMarkdown(input: string | null | undefined): string {
  if (!input) return '';
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length as 1 | 2 | 3;
      blocks.push({ type: `h${level}` as 'h1' | 'h2' | 'h3', text: h[2] });
      i++;
      continue;
    }

    if (/^-\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^-\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      const t = ln.trim();
      if (!t) break;
      if (/^(#{1,3})\s+/.test(t) || /^-\s+/.test(t) || /^\d+\.\s+/.test(t)) break;
      paragraphLines.push(t);
      i++;
    }
    blocks.push({ type: 'p', text: paragraphLines.join('\n') });
  }

  return blocks
    .map(b => {
      switch (b.type) {
        case 'ul':
        case 'ol':
          return `<${b.type}>${b.items.map(it => `<li>${renderInline(it)}</li>`).join('')}</${b.type}>`;
        case 'p':
          return `<p>${b.text.split('\n').map(renderInline).join('<br />')}</p>`;
        case 'h1':
        case 'h2':
        case 'h3':
          return `<${b.type}>${renderInline(b.text)}</${b.type}>`;
      }
    })
    .join('\n');
}
