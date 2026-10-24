// Snapshots the REAL demo storefronts into the phones on the ebda.app home page (Ruling MKT-PHONES-1).
//
//   node scripts/looks/snapshot.mjs [qamar,souq,...] [--out <dir>] [--no-images] [--dump <dir>]
//   npm run looks -w apps/marketing        (all five templates)
//
// For each template x look it loads the live demo (https://<host>.ebda.app/?look=<tpl>.<look>, Arabic, 360x760,
// reduced motion), takes the page's DOM and the CSS rules that apply to it at phone width, scopes them to one
// phone (#ph-<tpl>-<a|b|c>), re-hosts the photos, and wires the product cards to the in-phone engine
// (src/lib/phone-store-dom.ts) through data-* attributes. Output, under <out> (default public/looks/):
//   <tpl>.html      fragment: <style> + one block per look, separated by <!--look-->   (contract unchanged)
//   img/<hash>.webp photos
// and src/lib/looks-fonts.ts (Google Fonts families per template).
// Nothing is clicked or typed on the demo stores; the demo bar and the cookie banner are never copied, so no
// consent is recorded (same stance as live-shots.mjs). Needs Google Chrome + network.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import {
  SCOPE,
  classNamesIn,
  googleFamilies,
  keyframeNames,
  mergeRules,
  prefixKeyframes,
  phoneUnits,
  renameClassesCss,
  renameClassesHtml,
  scopeSelectorList,
} from './snapshot-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

// Template -> demo store host label, look ids and the phones' accessible names. Keep in step with DEMO_STORES in
// src/lib/site.ts (a unit test iterates both).
export const STORES = {
  qamar: {
    host: 'storedemo',
    ar: 'قمر',
    looks: [
      ['atelier', 'Qamar A Atelier'],
      ['lookbook', 'Qamar B Lookbook'],
      ['vitrine', 'Qamar C Vitrine'],
    ],
  },
  souq: {
    host: 'storedemo-souq',
    ar: 'سوق',
    looks: [
      ['catalogue', 'Souq A Catalogue'],
      ['night', 'Souq B Night souq'],
      ['showroom', 'Souq C Showroom'],
    ],
  },
  jasmine: {
    host: 'storedemo-jasmine',
    ar: 'ياسمين',
    looks: [
      ['apothecary', 'Jasmine A Apothecary'],
      ['bloom', 'Jasmine B Bloom'],
      ['clinic', 'Jasmine C Clinic'],
    ],
  },
  lamma: {
    host: 'storedemo-lamma',
    ar: 'لمّة',
    looks: [
      ['table', 'Lamma A Family table'],
      ['notebook', 'Lamma B Kitchen notebook'],
      ['market', 'Lamma C Fresh market'],
    ],
  },
  dahab: {
    host: 'storedemo-dahab',
    ar: 'دهب',
    looks: [
      ['worn', 'Dahab A Worn'],
      ['workshop', 'Dahab B Workshop'],
      ['giftbox', 'Dahab C Gift box'],
    ],
  },
};

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const only = (
  args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) ?? ''
)
  .split(',')
  .filter(Boolean);
const OUT = opt('--out') ? path.resolve(opt('--out')) : path.join(ROOT, 'public', 'looks');
const IMG_DIR = path.join(OUT, 'img');
const DUMP = opt('--dump') ? path.resolve(opt('--dump')) : null;
const WITH_IMAGES = !flag('--no-images');
const apex = process.env.DEMO_APEX ?? 'ebda.app';
const IMG_WIDTH = 720;

/** The marketing site's own class names: renamed inside the phones so the site's CSS cannot restyle them. */
const SITE_CLASSES = classNamesIn(
  readFileSync(path.join(ROOT, 'src', 'app', 'globals.css'), 'utf8')
);

// ---------------------------------------------------------------- page-side code (serialised into the page)

/** Runs in the demo page. Returns the cleaned DOM, the applicable CSS rules and the image URLs. */
function extractInPage({ phoneId, cats, pdp }) {
  const html = document.documentElement;
  const KEEP = el => el.id === 'main-content' || el.matches?.('nav[data-bottom-tab-bar]');

  // elements that are display:none at this width are not part of the phone (mobile-only/desktop-only twins)
  document.querySelectorAll('#main-content *, nav[data-bottom-tab-bar] *').forEach(el => {
    if (el.closest('[data-x-hide]')) return;
    if (getComputedStyle(el).display === 'none') el.setAttribute('data-x-hide', '');
  });

  // horizontal scrollers (chip rows, rails): a scroller with nothing focusable inside must itself be focusable
  document.querySelectorAll('#main-content *, nav[data-bottom-tab-bar] *').forEach(el => {
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)
      el.setAttribute('data-x-scroll', '');
  });

  const root = document.createElement('div');
  root.className = 'x-root ' + document.body.className;
  for (const a of document.body.attributes)
    if (a.name.startsWith('data-')) root.setAttribute(a.name, a.value);
  root.setAttribute('dir', 'rtl');
  root.setAttribute('lang', 'ar');
  const st = html.getAttribute('style');
  if (st) root.setAttribute('style', st);
  for (const el of document.body.children) if (KEEP(el)) root.appendChild(el.cloneNode(true));

  root
    .querySelectorAll(
      'script,noscript,style,link,iframe,dialog,template,video,canvas,[data-x-hide],[hidden],[data-toast-region],[data-zone="cookieFallback"],[data-demo-look-bar]'
    )
    .forEach(e => e.remove());

  // ---- products: the largest ancestor of a /products/<slug> link that holds only that product
  const slugOf = href => {
    const m = /^\/products\/([^/?#]+)/.exec(href ?? '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const slugsIn = el =>
    new Set(
      [...el.querySelectorAll('a[href^="/products/"]')].map(a => slugOf(a.getAttribute('href')))
    );
  const cardEls = new Map();
  for (const a of root.querySelectorAll('a[href^="/products/"]')) {
    const slug = slugOf(a.getAttribute('href'));
    if (!slug) continue;
    let c = a;
    while (c.parentElement && c.parentElement !== root && slugsIn(c.parentElement).size === 1)
      c = c.parentElement;
    if (!cardEls.has(c)) cardEls.set(c, slug);
  }
  const num = s => {
    const m = /(\d[\d,.]*)/.exec((s ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632)));
    if (!m) return NaN;
    return Number(m[1].replace(/,/g, ''));
  };
  const imgUrls = new Set();
  const productCards = [];
  for (const [card, slug] of cardEls) {
    const metaPrice = card.querySelector('meta[itemprop="price"]')?.getAttribute('content');
    const priceEl = card.querySelector('[data-zone="productPrice"]');
    let price = metaPrice ? Number(metaPrice) : num(priceEl?.textContent);
    if (!Number.isFinite(price)) {
      const m = /([\d][\d,.]*)\s*(?:ج\.?\s?م|EGP)/.exec(card.textContent.replace(/ /g, ' '));
      price = m ? num(m[1]) : NaN;
    }
    if (!Number.isFinite(price)) continue;
    const nameEl = card.querySelector('[data-zone="productName"]');
    const link =
      [...card.querySelectorAll('a[href^="/products/"]')].find(a => a.querySelector('img')) ??
      card.querySelector('a[href^="/products/"]');
    const name =
      nameEl?.textContent.trim() ||
      link?.textContent.trim() ||
      card.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt') ||
      (link?.getAttribute('aria-label') ?? '').split(/[,،]/)[0].trim();
    if (!name) continue;
    const oldEl = card.querySelector('[class*="line-through"], del, s');
    const old = oldEl ? num(oldEl.textContent) : NaN;
    const photoImgs = [...card.querySelectorAll('img')]
      .filter(i => !i.closest('[data-testid="swatch-dot"]') && i.getAttribute('src'))
      .map(i => i.getAttribute('src'));
    const extra = pdp[slug] ?? {};
    const imgs = [...new Set([...photoImgs.slice(0, 1), ...(extra.imgs ?? []), ...photoImgs])]
      .slice(0, 4)
      .map(u => new URL(u, location.href).href);
    imgs.forEach(u => imgUrls.add(u));
    const data = {
      id: slug,
      name,
      price: String(price),
      img: imgs[0] ?? '',
      imgs: imgs.join(','),
    };
    if (Number.isFinite(old) && old > price) data.old = String(old);
    const cat = Object.entries(cats)
      .filter(([, list]) => list.includes(slug))
      .map(([c]) => c)
      .join(' ');
    if (cat) data.cat = cat;
    if (extra.desc) data.desc = extra.desc;
    if (extra.sizes?.length) data.sizes = extra.sizes.join('|');
    if (extra.colors?.length)
      data.colors = extra.colors.map(c => (c.hex ? `${c.name}:${c.hex}` : c.name)).join('|');
    for (const [k, v] of Object.entries(data)) card.setAttribute(`data-p-${k}`, v);
    link?.classList.add('ph');
    productCards.push(card);
  }
  // grids: the parent that holds two or more cards is what the category filter hides cards in
  for (const card of productCards) {
    const p = card.parentElement;
    if (p && p !== root && [...p.children].filter(c => productCards.includes(c)).length >= 2)
      p.setAttribute('data-grid', '');
  }

  // ---- controls the engine binds to
  for (const a of root.querySelectorAll('a[href*="category="]')) {
    const slug = new URL(a.getAttribute('href'), 'https://x.test').searchParams.get('category');
    if (slug) a.setAttribute('data-cat', slug);
  }
  const mark = (el, attr) => {
    el.setAttribute(attr, '');
    return el;
  };
  for (const a of root.querySelectorAll('a[href="/cart"]')) {
    mark(a, 'data-open-cart').classList.add('ib');
    a.style.position = 'relative';
  }
  for (const a of root.querySelectorAll('a[href="/search"]')) mark(a, 'data-open-search');
  for (const b of root.querySelectorAll('button[aria-label="بحث"]')) mark(b, 'data-open-search');
  for (const b of root.querySelectorAll('button[aria-label="القائمة"]')) mark(b, 'data-open-menu');

  // ---- images: absolute URLs only, collected for re-hosting; photos in cards are decorative (the hit target is labelled)
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) {
      img.remove();
      continue;
    }
    const abs = new URL(src, location.href).href;
    img.setAttribute('src', abs);
    imgUrls.add(abs);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    if (img.closest('[data-p-id]')) img.setAttribute('alt', '');
  }
  for (const el of root.querySelectorAll('[style*="url("]')) {
    el.setAttribute(
      'style',
      el.getAttribute('style').replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, u) => {
        const abs = new URL(u, location.href).href;
        if (abs.startsWith('data:')) return m;
        imgUrls.add(abs);
        return `url("${abs}")`;
      })
    );
  }

  // ---- ids are per phone (three phones share one document)
  const idMap = new Map();
  for (const el of root.querySelectorAll('[id]')) idMap.set(el.id, `${phoneId}-${el.id}`);
  for (const el of root.querySelectorAll('[id]')) el.id = idMap.get(el.id);
  for (const el of root.querySelectorAll(
    '[aria-labelledby],[aria-describedby],[aria-controls],[for]'
  ))
    for (const a of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for']) {
      const v = el.getAttribute(a);
      if (v)
        el.setAttribute(
          a,
          v
            .split(/\s+/)
            .map(t => idMap.get(t) ?? t)
            .join(' ')
        );
    }

  // ---- inert: links and buttons do nothing unless the engine owns them (a11y: no dead tab stops)
  const engine = el =>
    el.matches(
      '[data-cat],[data-open-cart],[data-open-menu],[data-open-search],[data-add],[data-bundle],.ph'
    );
  for (const a of root.querySelectorAll('a')) {
    a.setAttribute('href', '#');
    a.removeAttribute('target');
    a.removeAttribute('rel');
    if (!engine(a)) a.setAttribute('tabindex', '-1');
  }
  for (const b of root.querySelectorAll('button')) {
    b.setAttribute('type', 'button');
    if (!engine(b)) b.setAttribute('tabindex', '-1');
  }
  for (const i of root.querySelectorAll('input,select,textarea')) {
    i.setAttribute('tabindex', '-1');
    if (i.tagName === 'INPUT') i.setAttribute('readonly', '');
    if (i.getAttribute('type') === 'hidden') i.removeAttribute('value');
    i.removeAttribute('name');
  }

  for (const el of root.querySelectorAll('[data-x-scroll]')) {
    el.removeAttribute('data-x-scroll');
    if (!el.querySelector('a:not([tabindex="-1"]), button:not([tabindex="-1"]), [tabindex="0"]'))
      el.setAttribute('tabindex', '0');
  }

  // ---- landmarks and form elements become plain blocks: fifteen phones must not add fifteen banners
  const plain = new Set(['HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'SECTION', 'FORM', 'H1']);
  const rename = el => {
    const to = el.tagName === 'H1' ? 'h2' : 'div';
    const n = document.createElement(to);
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    if (to === 'div') {
      n.removeAttribute('role');
      n.removeAttribute('aria-label');
      n.removeAttribute('action');
      n.removeAttribute('method');
    }
    while (el.firstChild) n.appendChild(el.firstChild);
    el.replaceWith(n);
  };
  // deepest first so replacing a parent never orphans a pending child
  [...root.querySelectorAll('*')]
    .filter(e => plain.has(e.tagName))
    .reverse()
    .forEach(rename);

  // ---- CSS: the rules that apply to this DOM at the phone's width
  const DYN =
    /::?(?:hover|focus-visible|focus-within|focus|active|visited|disabled|checked|placeholder-shown|placeholder|before|after|selection|backdrop|first-line|first-letter|marker|file-selector-button|autofill|target|open|popover-open|user-invalid|read-only|read-write|indeterminate|enabled|required|invalid|valid|out-of-range|in-range|optional|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?/g;
  const split = list => {
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
  };
  const used = sel => {
    if (/^(?:html|body|:root|:host)(?![\w-])/.test(sel) || /^(?:\*|::)/.test(sel)) return true;
    const t = sel.replace(DYN, '');
    try {
      return !!(root.querySelector(t) || root.matches(t));
    } catch {
      return true;
    }
  };
  const rules = [];
  const globals = [];
  const walk = (list, wrap) => {
    for (const r of list) {
      const T = r.constructor.name;
      if (T === 'CSSStyleRule') {
        const keep = split(r.selectorText).filter(used);
        if (!keep.length) continue;
        const body = r.cssText.slice(r.selectorText.length).trim();
        rules.push({ wrap, sel: keep.join(','), body });
      } else if (T === 'CSSMediaRule') {
        if (window.matchMedia(r.media.mediaText).matches) walk(r.cssRules, wrap);
      } else if (T === 'CSSSupportsRule') {
        if (CSS.supports(r.conditionText)) walk(r.cssRules, wrap);
      } else if (T === 'CSSLayerBlockRule') walk(r.cssRules, wrap);
      else if (T === 'CSSContainerRule')
        walk(r.cssRules, [...wrap, `@container ${r.conditionText}`]);
      else if (T === 'CSSKeyframesRule' || T === 'CSSPropertyRule') globals.push(r.cssText);
    }
  };
  const fontHrefs = [];
  for (const sheet of document.styleSheets) {
    if (sheet.href?.includes('fonts.googleapis.com')) fontHrefs.push(sheet.href);
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    walk(list, []);
  }

  const classes = new Set();
  root.querySelectorAll('[class]').forEach(e => e.classList.forEach(c => classes.add(c)));
  root.querySelectorAll('img').forEach(i => i.removeAttribute('data-nimg'));

  return {
    inner: root.innerHTML,
    rootAttrs: Object.fromEntries([...root.attributes].map(a => [a.name, a.value])),
    rules,
    globals,
    images: [...imgUrls],
    fontHrefs,
    tabbar: !!root.querySelector('[data-bottom-tab-bar]'),
    cards: productCards.length,
    classes: [...classes],
  };
}

/** Runs in a product page: description, gallery and size/colour options. */
function readProductInPage() {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => {
      try {
        return JSON.parse(s.textContent);
      } catch {
        return null;
      }
    })
    .find(d => d && d['@type'] === 'Product');
  const imgs = [
    ...new Set(
      [...document.querySelectorAll('[data-gallery] img')]
        .map(i => i.getAttribute('src'))
        .filter(Boolean)
        .map(s => new URL(s, location.href).href)
    ),
  ];
  const groups = [...document.querySelectorAll('[data-option-group]')].map(g => ({
    name: g.getAttribute('data-option-group'),
    items: [...g.querySelectorAll('button[aria-pressed]')].map(b => ({
      label: (b.getAttribute('aria-label') || b.textContent || '').trim(),
      hex: b.querySelector('[data-swatch-hex]')?.getAttribute('data-swatch-hex') ?? null,
      img: b.querySelector('img')?.getAttribute('src') ?? null,
    })),
  }));
  return { desc: ld?.description ?? '', category: ld?.category ?? '', imgs, groups };
}

// ---------------------------------------------------------------- node side

const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 12);
const imgName = url => `${sha(url)}.webp`;
const imgBuffers = new Map();

async function download(url) {
  if (imgBuffers.has(url)) return imgBuffers.get(url);
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      imgBuffers.set(url, buf);
      return buf;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw new Error(`image ${url}: ${last}`);
}

async function meanHex(url) {
  const { channels } = await sharp(await download(url))
    .resize(8, 8, { fit: 'cover' })
    .stats();
  const h = n => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(channels[0].mean)}${h(channels[1].mean)}${h(channels[2].mean)}`.toUpperCase();
}

const norm = s => (s ?? '').replace(/\s+/g, ' ').trim();

async function readCatalog(ctx, base, categories, slugs) {
  const page = await ctx.newPage();
  const cats = {};
  for (const c of categories) {
    await page.goto(`${base}/products?category=${encodeURIComponent(c)}`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await page.waitForSelector('a[href^="/products/"]', { timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    cats[c] = await page.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll('a[href^="/products/"]')]
          .map(a =>
            decodeURIComponent(
              (/^\/products\/([^/?#]+)/.exec(a.getAttribute('href')) ?? [])[1] ?? ''
            )
          )
          .filter(Boolean)
      ),
    ]);
  }
  const pdp = {};
  for (const slug of slugs) {
    await page.goto(`${base}/products/${encodeURIComponent(slug)}`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const r = await page.evaluate(readProductInPage);
    const sizeGroup = r.groups.find(g => /^size$|المقاس/i.test(g.name));
    const colourGroup = r.groups.find(g => /^colou?r$|اللون/i.test(g.name));
    const colors = [];
    for (const it of colourGroup?.items ?? []) {
      if (!it.label) continue;
      let hex = it.hex;
      if (!hex && it.img && WITH_IMAGES)
        hex = await meanHex(new URL(it.img, base).href).catch(() => null);
      colors.push({ name: it.label.replace(/[|:]/g, ' '), hex });
    }
    pdp[slug] = {
      desc: norm(r.desc),
      imgs: r.imgs,
      sizes: (sizeGroup?.items ?? []).map(i => i.label.replace(/\|/g, ' ')).filter(Boolean),
      colors,
    };
  }
  await page.close();
  return { cats, pdp };
}

/** Slugs and category slugs a template's looks link to (cheap pre-pass over the three home pages). */
async function discover(ctx, base, tpl, looks) {
  const page = await ctx.newPage();
  const cats = new Set();
  const slugs = new Set();
  for (const [look] of looks) {
    await page.goto(`${base}/?look=${tpl}.${look}`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      cats: [...document.querySelectorAll('a[href*="category="]')].map(a =>
        new URL(a.getAttribute('href'), location.href).searchParams.get('category')
      ),
      slugs: [...document.querySelectorAll('a[href^="/products/"]')].map(a =>
        decodeURIComponent((/^\/products\/([^/?#]+)/.exec(a.getAttribute('href')) ?? [])[1] ?? '')
      ),
    }));
    r.cats.filter(Boolean).forEach(c => cats.add(c));
    r.slugs.filter(Boolean).forEach(s => slugs.add(s));
  }
  await page.close();
  return { categories: [...cats].sort(), slugs: [...slugs].sort() };
}

/** Scope one look's rules; returns the strings mergeRules expects. */
function scopeRules(rules, renamed) {
  const out = [];
  for (const r of rules) {
    let sel = scopeSelectorList(r.sel);
    if (!sel) continue;
    // units are converted in the declarations only: a selector's escaped class (w-\\[44vw\\]) must keep matching the DOM
    let css = renameClassesCss(`${sel}${phoneUnits(r.body)}`, renamed);
    for (const w of [...r.wrap].reverse()) css = `${w}{${css}}`;
    out.push(css.replace(/\s*\n\s*/g, ' '));
  }
  return out;
}

const BASE_CSS =
  `${SCOPE}{width:100%;height:100%;overflow-y:auto;overflow-x:hidden;position:relative;isolation:isolate;scrollbar-width:thin;-webkit-overflow-scrolling:touch;` +
  `--bg:hsl(var(--background));--ink:hsl(var(--foreground));--mut:hsl(var(--muted-foreground));--ac:hsl(var(--accent));` +
  `--btn:hsl(var(--primary));--btnfg:hsl(var(--primary-foreground));--r:var(--radius);--rs:var(--radius);--rb:var(--radius);` +
  `--fd:var(--font-display);--fb:var(--font-body);--ga:3/4}` +
  `${SCOPE} .x-root{min-height:100%}` +
  `${SCOPE} [data-cat].on{outline:2px solid var(--ac);outline-offset:-2px}` +
  `${SCOPE} [data-p-id].ps-off{display:none}`;

function engineCss(scope) {
  const css = readFileSync(path.join(HERE, 'phone-store.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll('&', scope);
  return css.replace(/\s*\n\s*/g, ' ').trim();
}

const fam = f => f.split(':')[0].replace(/\+/g, ' ');

async function main() {
  mkdirSync(IMG_DIR, { recursive: true });
  const templates = only.length ? only : Object.keys(STORES);
  const browser = await chromium.launch({ channel: 'chrome' });
  const usedImages = new Set();
  const fontsByTpl = {};
  const report = [];
  try {
    for (const tpl of templates) {
      const cfg = STORES[tpl];
      if (!cfg) throw new Error(`unknown template ${tpl}`);
      const base = `https://${cfg.host}.${apex}`;
      const ctx = await browser.newContext({
        viewport: { width: 360, height: 760 },
        deviceScaleFactor: 2,
        locale: 'ar-EG',
        reducedMotion: 'reduce',
      });
      await ctx.addCookies([{ name: 'force-language', value: 'ar', url: base }]);
      // warm-up: Neon cold starts make the first request slow or empty
      for (let i = 0; i < 3; i++) {
        const r = await ctx.request.get(`${base}/`, { timeout: 60_000 }).catch(() => null);
        if (r?.ok()) break;
      }
      const found = await discover(ctx, base, tpl, cfg.looks);
      const catalog = await readCatalog(ctx, base, found.categories, found.slugs);

      const phones = [];
      const tplFonts = new Set();
      for (const [i, [look, label]] of cfg.looks.entries()) {
        const letter = 'abc'[i];
        const phoneId = `ph-${tpl}-${letter}`;
        let x;
        for (let attempt = 1; attempt <= 3 && !x; attempt++) {
          const page = await ctx.newPage();
          await page.goto(`${base}/?look=${tpl}.${look}`, { waitUntil: 'load', timeout: 60_000 });
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          // the tab bar and the product grid are client-rendered: do not snapshot a half-hydrated page
          await page
            .waitForSelector('nav[data-bottom-tab-bar], a[href="/cart"]', { timeout: 20_000 })
            .catch(() => {});
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(1500);
          const got = await page.evaluate(extractInPage, {
            phoneId,
            cats: catalog.cats,
            pdp: catalog.pdp,
          });
          await page.close();
          if (got.tabbar && got.cards) x = got;
          else
            console.warn(
              `${tpl}.${look}: attempt ${attempt} incomplete (cart/cards missing), retrying`
            );
        }
        if (DUMP) {
          mkdirSync(DUMP, { recursive: true });
          writeFileSync(path.join(DUMP, `${tpl}-${look}.json`), JSON.stringify(x));
        }
        if (!x)
          throw new Error(
            `${tpl}.${look}: no cart control or product cards after 3 attempts (engine needs them)`
          );
        x.fontHrefs.flatMap(googleFamilies).forEach(f => tplFonts.add(f));
        phones.push({ id: phoneId, letter, look, label, x });
      }

      // images: re-hosted next to the fragments, named by URL hash (idempotent runs)
      const allUrls = new Set(phones.flatMap(p => p.x.images));
      const urlMap = new Map();
      for (const u of allUrls) urlMap.set(u, `/looks/img/${imgName(u)}`);
      if (WITH_IMAGES) {
        for (const u of allUrls) {
          const file = path.join(IMG_DIR, imgName(u));
          usedImages.add(imgName(u));
          if (existsSync(file) && !flag('--refresh-images')) continue;
          const buf = await sharp(await download(u))
            .resize({ width: IMG_WIDTH, withoutEnlargement: true })
            .webp({ quality: 70, effort: 6 })
            .toBuffer();
          writeFileSync(file, buf);
        }
      }
      const byLength = [...urlMap].sort((a, b) => b[0].length - a[0].length);
      const swapUrls = s => {
        let out = s;
        for (const [u, local] of byLength) out = out.split(u).join(local);
        return out;
      };

      const renamed = new Set();
      for (const p of phones) for (const c of p.x.classes) if (SITE_CLASSES.has(c)) renamed.add(c);

      const phoneRules = phones.map(p => ({
        id: p.id,
        rules: scopeRules(p.x.rules, renamed).map(swapUrls),
      }));
      for (const pr of phoneRules) pr.rules.push(BASE_CSS);
      const globalsRaw = [...new Set(phones.flatMap(p => p.x.globals))]
        .map(phoneUnits)
        .map(swapUrls);
      // @keyframes are document-global: prefix them per template (@property rules are identical Tailwind internals)
      const kf = keyframeNames(globalsRaw);
      const kfPrefix = `ph-${tpl}-`;
      for (const pr of phoneRules) pr.rules = pr.rules.map(r => prefixKeyframes(r, kf, kfPrefix));
      const globals = globalsRaw.map(g => prefixKeyframes(g, kf, kfPrefix));
      const all = `:is(${phones.map(p => '#' + p.id).join(',')})`;
      const css = mergeRules(phoneRules) + globals.join('') + engineCss(all);

      const blocks = phones.map(p => {
        const { rootAttrs } = p.x;
        const attrs = Object.entries(rootAttrs)
          .filter(([k]) => k !== 'class')
          .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
          .join('');
        const cls = renameClassesHtml(` class="${rootAttrs.class}"`, renamed);
        const inner = renameClassesHtml(swapUrls(p.x.inner), renamed);
        return (
          `<div class="scr" id="${p.id}" dir="rtl" lang="ar" tabindex="0" role="region" ` +
          `aria-label="${cfg.ar} · ${p.label}"><div${cls}${attrs}>${inner}</div></div>`
        );
      });
      const frag = `<style>${css}</style><!--look-->${blocks.join('<!--look-->')}`;
      if (/(?:src|href|srcset)="https?:\/\/|url\(\s*["']?https?:\/\//.test(frag))
        throw new Error(`${tpl}: remote asset URL left in the fragment`);
      if (/\bdata:|base64/.test(frag.replace(/data-[\w-]+/g, '')))
        throw new Error(`${tpl}: inline data URI`);
      writeFileSync(path.join(OUT, `${tpl}.html`), frag);
      fontsByTpl[tpl] = [...tplFonts];
      report.push(
        `${tpl}: ${(Buffer.byteLength(frag) / 1024).toFixed(0)} KB fragment, ${allUrls.size} images, cards ${phones.map(p => p.x.cards).join('/')}, ${renamed.size} renamed classes`
      );
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  if (WITH_IMAGES && !only.length) {
    for (const f of readdirSync(IMG_DIR)) if (!usedImages.has(f)) rmSync(path.join(IMG_DIR, f));
  }
  if (!only.length && !opt('--out')) {
    const ts =
      '// Generated by scripts/looks/snapshot.mjs (npm run looks). Do not edit by hand.\n' +
      "// Google Fonts families (css2 `family=` values) each template's looks need.\n" +
      'export const LOOK_FONTS = {\n' +
      Object.entries(fontsByTpl)
        .map(([t, f]) => `  ${t}: [${f.map(x => `'${x}'`).join(', ')}],\n`)
        .join('') +
      '} as const;\n';
    const target = path.join(ROOT, 'src', 'lib', 'looks-fonts.ts');
    const prettier = await import('prettier');
    writeFileSync(
      target,
      await prettier.format(ts, { ...(await prettier.resolveConfig(target)), filepath: target })
    );
  }
  console.log(report.join('\n'));
  void fam;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();
