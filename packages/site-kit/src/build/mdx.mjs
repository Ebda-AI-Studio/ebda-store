// MDX -> static HTML. Components are plain React rendered with renderToStaticMarkup, so the
// shipped pages carry no framework runtime. Frontmatter is a flat `key: value` block.
import { evaluate } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import * as runtime from 'react/jsx-runtime';
import { createElement as h, Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    data[key] = /^-?\d+$/.test(val) ? Number(val) : val;
  }
  return { data, body: src.slice(m[0].length) };
}

function textOf(node) {
  let out = '';
  Children.forEach(node, c => {
    if (typeof c === 'string' || typeof c === 'number') out += c;
    else if (isValidElement(c)) out += textOf(c.props.children);
  });
  return out;
}

/** Unicode-aware slug (keeps Arabic letters). */
export function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/**
 * @param {string} body MDX source (no frontmatter)
 * @param {{ components?: Record<string, unknown>, linkBase?: string }} [opts]
 * @returns {Promise<{ html: string, headings: {id:string,text:string,level:number}[] }>}
 */
export async function renderMdx(body, opts = {}) {
  const { default: Content } = await evaluate(body, {
    ...runtime,
    development: false,
    remarkPlugins: [remarkGfm],
  });
  const headings = [];
  const seen = new Map();
  let tables = 0;
  const heading = level => props => {
    const text = textOf(props.children);
    let id = slugify(text);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;
    headings.push({ id, text, level });
    return h(`h${level}`, { id }, props.children);
  };
  const components = {
    h2: heading(2),
    h3: heading(3),
    // Scrollable regions must be keyboard reachable (axe: scrollable-region-focusable).
    pre: props => h('pre', { tabIndex: 0 }, props.children),
    // Each region needs a unique accessible name (axe: landmark-unique), so number them.
    table: props => {
      tables += 1;
      const label = `${opts.tableLabel ?? 'Table'}${tables > 1 ? ` (${tables})` : ''}`;
      return h(
        'div',
        { className: 'table-scroll', tabIndex: 0, role: 'region', 'aria-label': label },
        h('table', null, props.children)
      );
    },
    a: ({ href = '', children, ...rest }) =>
      h('a', { href, ...(/^https?:/.test(href) && !href.includes('.ebda.app') ? { rel: 'noopener' } : {}), ...rest }, children),
    Callout: ({ type = 'note', title, children }) =>
      h('aside', { className: `callout callout-${type}` }, title ? h('strong', null, title) : null, children),
    ...opts.components,
  };
  const html = renderToStaticMarkup(h(Content, { components }));
  return { html, headings };
}
