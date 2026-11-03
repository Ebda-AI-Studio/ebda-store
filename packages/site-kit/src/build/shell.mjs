// Static page shell shared by docs + help: header (wordmark, nav, language switch, search),
// optional sidebar, footer. Pure string templates; no client framework.
import {
  BRAND,
  BRAND_MARKETING_URL,
  SITE_NAV_CSS,
  SITE_ART_CSS,
  SITE_FOOTER_CSS,
  SITE_NAV_JS,
  siteFooterHtml,
  siteNavHtml,
  siteWordmarkHtml,
} from '@ebda/shared/brand';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The shared social card for help and docs (the same image ebda.app shares: 1200x630). */
export const OG_IMAGE = { url: `${BRAND_MARKETING_URL}/og.png`, width: 1200, height: 630 };

/** JSON-LD graph of one page: the studio, a WebSite on the home, and BreadcrumbList + Article on a content page. */
export function pageJsonLd(p) {
  const org = `${BRAND_MARKETING_URL}/#organization`;
  const origin = new URL(p.canonical).origin;
  const homeUrl = origin + p.homeHref;
  const lang = p.lang;
  const publisher = {
    '@type': 'Organization',
    '@id': org,
    name: lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn,
    url: BRAND_MARKETING_URL,
    logo: `${BRAND_MARKETING_URL}/icon-512.png`,
  };
  const graph = [publisher];
  const isHome = p.canonical === homeUrl;
  if (isHome) {
    graph.push({
      '@type': 'WebSite',
      url: homeUrl,
      name: p.siteLabel,
      inLanguage: lang,
      publisher: { '@id': org },
    });
  } else if (!(p.scripts && p.scripts.length)) {
    // a content page (not the search page, which is noindex): breadcrumb + article
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: p.siteLabel, item: homeUrl },
        { '@type': 'ListItem', position: 2, name: p.title.split(' | ')[0], item: p.canonical },
      ],
    });
    graph.push({
      '@type': 'Article',
      headline: p.title.split(' | ')[0],
      description: p.description,
      inLanguage: lang,
      mainEntityOfPage: p.canonical,
      image: OG_IMAGE.url,
      author: { '@id': org },
      publisher: { '@id': org },
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** The head of one page: social card (og + twitter) and JSON-LD. */
export function socialHead(p) {
  const locale = p.lang === 'ar' ? 'ar_EG' : 'en_US';
  const image = p.ogImage ?? OG_IMAGE.url;
  const ld = JSON.stringify(pageJsonLd(p)).replace(/</g, '\\u003c');
  return (
    `<meta property="og:site_name" content="${esc(p.siteLabel)}">` +
    `<meta property="og:locale" content="${locale}">` +
    `<meta property="og:image" content="${esc(image)}">` +
    `<meta property="og:image:width" content="${OG_IMAGE.width}"><meta property="og:image:height" content="${OG_IMAGE.height}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${esc(p.title)}">` +
    `<meta name="twitter:description" content="${esc(p.description)}">` +
    `<meta name="twitter:image" content="${esc(image)}">` +
    `<script type="application/ld+json">${ld}</script>`
  );
}

/** Copy the shared stylesheet into `<outDir>/assets/site.css`. */
export function writeSiteCss(outDir) {
  mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  // the shared header nav (packages/shared/src/brand/index.ts) styles itself with the same string status inlines
  writeFileSync(
    path.join(outDir, 'assets', 'site.css'),
    readFileSync(path.join(here, '..', 'css', 'site.css'), 'utf8') + '\n' + SITE_NAV_CSS + SITE_FOOTER_CSS + SITE_ART_CSS
  );
  // the shared header-nav behaviour: a same-origin static file, no inline code (strict CSP)
  writeFileSync(path.join(outDir, 'assets', 'site-nav.js'), SITE_NAV_JS);
}

const tokensCss = () =>
  `:root{--night:${BRAND.colors.night};--gold:${BRAND.colors.gold};--lift:${BRAND.colors.lift};` +
  `--font-ar:${BRAND.fonts.stacks.arabic};--font-sans:${BRAND.fonts.stacks.sans};--font-mono:${BRAND.fonts.stacks.mono}}`;

/**
 * @param {object} p
 * @param {'ar'|'en'} p.lang
 * @param {string} p.title            page <title> (already includes the site name)
 * @param {string} p.description
 * @param {string} p.canonical        absolute URL
 * @param {{hreflang:string, href:string}[]} [p.alternates]
 * @param {string} p.siteLabel        e.g. "Docs" / "مركز المساعدة"
 * @param {string} p.homeHref
 * @param {'docs'|'help'} p.active    the site this page belongs to (its nav link gets aria-current)
 * @param {{href:string,label:string,lang:string}} [p.langSwitch]
 * @param {{action:string,label:string,placeholder:string,index?:string}} p.search
 * @param {string} [p.sidebar]        html (a <nav>)
 * @param {string} p.main             html
 * @param {string} p.footer           html
 * @param {string[]} [p.scripts]
 * @param {string} p.skipLabel
 * @param {string} [p.ogImage]
 * @param {boolean} [p.tess]  a landing or index page: the faint tessellation watermark behind the main column
 * @param {boolean} [p.noHeaderSearch]  omit the header search box (a page that carries its own, e.g. the 404)
 */
export function renderPage(p) {
  const dir = p.lang === 'ar' ? 'rtl' : 'ltr';
  const alts = (p.alternates ?? [])
    .map(a => `<link rel="alternate" hreflang="${a.hreflang}" href="${esc(a.href)}">`)
    .join('');
  const sw = p.langSwitch
    ? `<a class="lang-switch" href="${esc(p.langSwitch.href)}" hreflang="${p.langSwitch.lang}" lang="${p.langSwitch.lang}">${esc(p.langSwitch.label)}</a>`
    : '';
  return `<!doctype html>
<html lang="${p.lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta name="theme-color" content="${BRAND.colors.night}">
<link rel="canonical" href="${esc(p.canonical)}">${alts}
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(p.canonical)}">
<meta property="og:type" content="website">
${socialHead(p)}
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${tokensCss()}</style>
<link rel="stylesheet" href="/assets/site.css">
<script>var l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(BRAND.fonts.googleFontsUrl)};document.head.appendChild(l);</script>
<noscript><link rel="stylesheet" href="${esc(BRAND.fonts.googleFontsUrl)}"></noscript>
</head>
<body>
<a class="skip" href="#main">${esc(p.skipLabel)}</a>
<header class="site-header">
  <div class="wrap header-row">
    ${siteWordmarkHtml({ lang: p.lang, href: p.homeHref, siteLabel: p.siteLabel, markHtml: '<img src="/icon.svg" alt="" width="28" height="28">' })}
    ${siteNavHtml(p.lang, p.active)}
    ${p.noHeaderSearch ? '' : searchForm(p, 'q', 'search')}
    ${sw}
  </div>
</header>
<div class="wrap layout${p.sidebar ? ' has-side' : ''}">
${p.sidebar ?? ''}
<main id="main" class="main${p.tess ? ' tess' : ''}">
${p.main}
</main>
</div>
${p.footer}
<script src="/assets/site-nav.js" defer></script>
<script src="/assets/typeahead.js" defer></script>${(p.scripts ?? []).map(s => `<script src="${esc(s)}" defer></script>`).join('')}
</body>
</html>
`;
}

/** The search form: a plain GET to the search page that /assets/typeahead.js upgrades to a live combobox. */
function searchForm(p, id, cls) {
  return `<form class="${cls}" role="search" action="${esc(p.search.action)}" method="get" data-index="${esc(p.search.index ?? `/search-index.${p.lang}.json`)}">
      <label class="sr-only" for="${id}">${esc(p.search.label)}</label>
      <input id="${id}" name="q" type="search" placeholder="${esc(p.search.placeholder)}" autocomplete="off" enterkeyhint="search">
      <button type="submit">${esc(p.search.label)}</button>
    </form>`;
}

/**
 * The Apple-style 404 body for a static site: one calm sentence, the live search box (the same typeahead as the
 * header, in the page where the visitor is looking), and a compact map of the site's sections.
 * @param {{lang:'ar'|'en', search:{action:string,label:string,placeholder:string,index?:string}, line:string, hint:string, mapLabel:string, groups:{title:string,links:{href:string,label:string}[]}[]}} p
 */
export function render404Main(p) {
  const groups = p.groups
    .map(
      g =>
        `<div><h2>${esc(g.title)}</h2><ul>${g.links.map(l => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join('')}</ul></div>`
    )
    .join('');
  return `<div class="nf">
<h1>${esc(p.line)}</h1>
<p class="muted">${esc(p.hint)}</p>
${searchForm(p, 'q', 'search nf-search')}
<nav class="nf-map" aria-label="${esc(p.mapLabel)}">${groups}</nav>
</div>`;
}

/** Sidebar nav from groups: [{title, items:[{href,label,current}]}] */
export function renderSidebar(groups, label) {
  return `<nav class="side" aria-label="${esc(label)}">${groups
    .map(
      g =>
        `<h2 class="side-title">${esc(g.title)}</h2><ul>${g.items
          .map(
            i =>
              `<li><a href="${esc(i.href)}"${i.current ? ' aria-current="page"' : ''}>${esc(i.label)}</a></li>`
          )
          .join('')}</ul>`
    )
    .join('')}</nav>`;
}

export function renderToc(headings, label) {
  const items = headings.filter(h => h.level === 2);
  if (items.length < 2) return '';
  return `<nav class="toc" aria-label="${esc(label)}"><ul>${items
    .map(h => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('')}</ul></nav>`;
}

/** The one studio footer (brand module `siteFooterHtml`): the same five columns on help, docs and status. */
export function renderFooter({ lang }) {
  return siteFooterHtml(lang, '<img class="sf-mark" src="/icon.svg" alt="" width="24" height="24">', new Date().getUTCFullYear());
}

/** Search results page body (script reads data-* attributes). */
export function renderSearchMain({ lang, title, indexUrl, messages, intro }) {
  return `<h1>${esc(title)}</h1>
<p class="muted">${esc(intro)}</p>
<div id="search-root" data-lang="${lang}" data-index="${esc(indexUrl)}" data-messages="${esc(JSON.stringify(messages))}">
<p id="results-status" role="status" aria-live="polite" class="muted"></p>
<ul id="results" class="results"></ul>
<noscript><p>${esc(messages.noscript)}</p></noscript>
</div>`;
}

export function writeSeoFiles(outDir, origin, urls, extraRobots = '') {
  const abs = u => new URL(u, origin).toString();
  writeFileSync(
    path.join(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map(u => `<url><loc>${esc(abs(u))}</loc></url>`)
      .join('\n')}\n</urlset>\n`
  );
  writeFileSync(
    path.join(outDir, 'robots.txt'),
    `User-agent: *\nAllow: /\n${extraRobots}Sitemap: ${abs('/sitemap.xml')}\n`
  );
}
