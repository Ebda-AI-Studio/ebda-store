// Pure helpers for scripts/looks/snapshot.mjs (Ruling MKT-PHONES-1). No browser, no network, no fs:
// everything here is unit-tested (tests/unit/marketing-looks-snapshot-lib.test.ts) on small fixtures.

/** Placeholder for the phone's own selector; replaced per phone when the CSS is assembled. */
export const SCOPE = '@@';

/** Split a selector list on top-level commas (commas inside :is(), :not(), [attr="a,b"] stay). */
export function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0 && !quote) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Re-root one selector under the phone. html / body / :root / :host become .x-root (it carries the page's
 * <html> style variables, the <body> class and data-* attributes); everything else becomes a descendant.
 * Returns null for selectors that cannot apply inside a phone (::backdrop).
 */
export function scopeSelector(sel) {
  const s = sel.trim();
  if (!s || /^::?backdrop/.test(s)) return null;
  const root = /^(?:html|body|:root|:host)(?![\w-])/.exec(s);
  // the phone wraps its content in .x-root, which stands in for <html> and <body>
  if (root) return `${SCOPE} .x-root${s.slice(root[0].length)}`;
  return `${SCOPE} ${s}`;
}

/** Selector list -> scoped list ('' when nothing survives). */
export function scopeSelectorList(list) {
  return splitSelectors(list).map(scopeSelector).filter(Boolean).join(',');
}

/**
 * Viewport units become container units of the phone (.look-screen is a size container), so
 * `100vh` fills the phone, not the browser window it is shown in.
 */
export function phoneUnits(css) {
  return css
    .replace(/(-?\d*\.?\d+)(?:d|s|l)?vh\b/g, '$1cqh')
    .replace(/(-?\d*\.?\d+)(?:d|s|l)?vw\b/g, '$1cqw')
    .replace(/(-?\d*\.?\d+)(?:d|s|l)?vmin\b/g, '$1cqmin')
    .replace(/(-?\d*\.?\d+)(?:d|s|l)?vmax\b/g, '$1cqmax');
}

/** Rename every class token in `names` to x-<name> inside CSS selectors (not inside declarations). */
export function renameClassesCss(css, names) {
  if (!names.size) return css;
  const alt = [...names].map(n => n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
  const re = new RegExp(`\\.(${alt})(?![\\w-])`, 'g');
  // only rewrite the selector part of each rule: text before '{'
  return css.replace(/([^{}]+)\{/g, (m, sel) => sel.replace(re, '.x-$1') + '{');
}

export function renameClassesHtml(html, names) {
  if (!names.size) return html;
  return html.replace(
    /\sclass="([^"]*)"/g,
    (m, c) =>
      ` class="${c
        .split(/\s+/)
        .map(t => (names.has(t) ? `x-${t}` : t))
        .join(' ')}"`
  );
}

/** Class names defined by a stylesheet text (`.foo` in selectors). */
export function classNamesIn(css) {
  const out = new Set();
  for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]);
  return out;
}

/**
 * Merge per-phone rule lists. A rule present, byte for byte (SCOPE placeholder intact), in every
 * phone is written once for all of them; the rest stay with their phone. Returns CSS text.
 * `phones` = [{ id, rules: string[] }]; rule strings use SCOPE as the phone selector.
 */
export function mergeRules(phones) {
  const all = `:is(${phones.map(p => '#' + p.id).join(',')})`;
  const sets = phones.map(p => new Set(p.rules));
  // A rule is shared only if it sits in the same relative order in every phone, so hoisting it never
  // changes the cascade between same-specificity rules of one phone.
  const shared = [];
  const last = phones.map(() => -1);
  for (const r of phones[0].rules) {
    if (!sets.every(s => s.has(r)) || shared.includes(r)) continue;
    const pos = phones.map(p => p.rules.indexOf(r));
    if (pos.some((x, i) => x <= last[i])) continue;
    pos.forEach((x, i) => (last[i] = x));
    shared.push(r);
  }
  const isShared = new Set(shared);
  const ptr = phones.map(() => 0);
  const out = [];
  const flush = (i, upTo) => {
    const p = phones[i];
    const seen = new Set();
    for (; ptr[i] < upTo; ptr[i]++) {
      const r = p.rules[ptr[i]];
      if (isShared.has(r) || seen.has(r)) continue;
      seen.add(r);
      out.push(r.replaceAll(SCOPE, '#' + p.id));
    }
  };
  for (const r of shared) {
    phones.forEach((p, i) => flush(i, p.rules.indexOf(r)));
    phones.forEach((p, i) => (ptr[i] = p.rules.indexOf(r) + 1));
    out.push(r.replaceAll(SCOPE, all));
  }
  phones.forEach((p, i) => flush(i, p.rules.length));
  return out.join('');
}

/** Names declared by @keyframes in the given CSS texts. */
export function keyframeNames(texts) {
  const out = new Set();
  for (const t of texts) for (const m of t.matchAll(/@keyframes\s+([\w-]+)/g)) out.add(m[1]);
  return out;
}

/**
 * Keyframe names are global to the whole document: give the phones' own a prefix, in the @keyframes rule and in
 * every `animation` / `animation-name` declaration that uses them.
 */
export function prefixKeyframes(css, names, prefix) {
  if (!names.size) return css;
  const alt = [...names].map(n => n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
  const word = new RegExp(`(?<![\\w-])(${alt})(?![\\w-])`, 'g');
  return css
    .replace(
      new RegExp(`@keyframes\\s+(${alt})(?![\\w-])`, 'g'),
      (m, n) => `@keyframes ${prefix}${n}`
    )
    .replace(
      /(animation(?:-name)?\s*:)([^;}]*)/g,
      (m, head, val) => head + val.replace(word, `${prefix}$1`)
    );
}

/** Google Fonts `family=` values (Name+Of+Font:wght@400;700) from a stylesheet URL. */
export function googleFamilies(href) {
  try {
    const u = new URL(href.replace(/&amp;/g, '&'));
    if (u.hostname !== 'fonts.googleapis.com') return [];
    return u.search
      .slice(1)
      .split('&')
      .filter(p => p.startsWith('family='))
      .map(p =>
        p.slice('family='.length).replace(/%3A/gi, ':').replace(/%40/gi, '@').replace(/%3B/gi, ';')
      );
  } catch {
    return [];
  }
}

/** The text that matters for drift: visible text and the class set, nothing positional. */
export function normalise(frag) {
  const looks = frag.split('<!--look-->').slice(1);
  return looks.map(html => {
    const text = html
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const classes = new Set();
    for (const m of html.matchAll(/\sclass="([^"]*)"/g))
      for (const c of m[1].split(/\s+/)) if (c && !c.startsWith('ps-')) classes.add(c);
    return { text, classes: [...classes].sort() };
  });
}

/** Differences between two normalised fragments (same template): human-readable lines. */
export function diffNormalised(template, a, b) {
  const out = [];
  if (a.length !== b.length) out.push(`${template}: ${a.length} looks vs ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const label = `${template} look ${'ABC'[i]}`;
    if (a[i].text !== b[i].text) out.push(`${label}: visible text differs`);
    const ca = new Set(a[i].classes);
    const cb = new Set(b[i].classes);
    const gone = [...ca].filter(c => !cb.has(c));
    const added = [...cb].filter(c => !ca.has(c));
    if (gone.length || added.length)
      out.push(`${label}: class set differs (-${gone.length} +${added.length})`);
  }
  return out;
}
