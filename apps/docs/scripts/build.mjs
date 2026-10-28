// Static build for docs.ebda.app: MDX (content/*.mdx) + the generated OpenAPI reference ->
// out/. English first, with an Arabic landing page at /ar/. No runtime API calls.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, BRAND_MARKETING_URL, siteNavItems } from '@ebda/shared/brand';
import { renderMdx } from '@ebda/site-kit/build/mdx';
import {
  esc,
  renderFooter,
  renderPage,
  renderSearchMain,
  render404Main,
  renderSidebar,
  renderToc,
  writeSeoFiles,
  writeSiteCss,
} from '@ebda/site-kit/build/shell';
import { writeSearchAssets } from '@ebda/site-kit/build/search';
import { loadContent, resetOut, writePage } from '@ebda/site-kit/build/site';
import { renderOpenApi } from './openapi-render.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
const ORIGIN = `https://${BRAND.domains.docs}`;
const url = slug => (slug === 'index' ? '/' : `/${slug}/`);

const SECTIONS = ['Start', 'Concepts', 'Reference'];
/** The products this site documents (BRAND-ARCH-1). A product is added when it ships; never a placeholder. */
const PRODUCT = BRAND.product.nameEn;
const EN = {
  site: `${BRAND.company.shortNameEn} Docs`,
  skip: 'Skip to content',
  search: { action: '/search/', label: 'Search', placeholder: 'Search the docs' },
  footer: `© ${new Date().getUTCFullYear()} ${BRAND.company.shortNameEn}. ${BRAND.product.nameEn} developer documentation.`,
  sidebarLabel: 'Documentation',
  tocLabel: 'On this page',
  openapi: {
    fields: 'Fields',
    field: 'Name',
    type: 'Type',
    description: 'Description',
    required: 'required',
    in: 'In',
    parameters: 'Parameters',
    requestBody: 'Request body',
    responses: 'Responses',
    schemas: 'Schemas',
    authRequired: 'Requires authentication (Bearer access token or the auth cookie).',
    authNone: 'No authentication required.',
  },
};

resetOut(out, path.join(root, 'public'));
writeSiteCss(out);

const pages = loadContent(path.join(root, 'content'));
const arIndex = loadContent(path.join(root, 'content', 'ar'))[0];
const spec = JSON.parse(readFileSync(path.join(root, '.generated', 'openapi.json'), 'utf8'));
const coverage = JSON.parse(readFileSync(path.join(root, '.generated', 'coverage.json'), 'utf8'));
copyFileSync(path.join(root, '.generated', 'openapi.json'), path.join(out, 'openapi.json'));

const REF = {
  slug: 'api-reference',
  title: 'Generated API reference',
  section: 'Reference',
  order: 40,
  description:
    'Endpoint reference generated at build time from the OpenAPI annotations in the Ebda Store API source.',
};

const allNav = [
  ...pages.map(p => ({
    slug: p.slug,
    title: p.data.title,
    section: p.data.section,
    order: p.data.order,
  })),
  REF,
];
const sidebarFor = current =>
  renderSidebar(
    SECTIONS.map(section => ({
      title: `${PRODUCT} · ${section}`,
      items: allNav
        .filter(p => p.section === section)
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
        .map(p => ({ href: url(p.slug), label: p.title, current: p.slug === current })),
    })).filter(g => g.items.length),
    EN.sidebarLabel
  );

const footer = renderFooter({
  copy: EN.footer,
  links: [
    { href: `${BRAND_MARKETING_URL}/terms/`, label: 'Terms' },
    { href: `${BRAND_MARKETING_URL}/privacy/`, label: 'Privacy' },
    { href: `https://${BRAND.domains.status}`, label: 'Status' },
    { href: `mailto:${BRAND.supportEmail}`, label: BRAND.supportEmail },
  ],
});

const searchDocs = [];
const urls = ['/', '/ar/', '/search/'];

function enPage({ slug, title, description, section, main, headings, bodyHtml }) {
  const html = renderPage({
    lang: 'en',
    title:
      slug === 'index'
        ? `${BRAND.company.shortNameEn} Docs`
        : `${title} | ${BRAND.company.shortNameEn} Docs`,
    description,
    canonical: ORIGIN + url(slug),
    alternates: [
      { hreflang: 'en', href: ORIGIN + '/' },
      { hreflang: 'ar', href: ORIGIN + '/ar/' },
    ],
    siteLabel: EN.site,
    homeHref: '/',
    active: 'docs',
    langSwitch: { href: '/ar/', label: 'العربية', lang: 'ar' },
    search: EN.search,
    sidebar: sidebarFor(slug),
    main: `<article class="prose">${renderToc(headings, EN.tocLabel)}${main}</article>`,
    footer,
    skipLabel: EN.skip,
  });
  writePage(out, url(slug), html);
  if (slug !== 'index') urls.push(url(slug));
  searchDocs.push({
    url: url(slug),
    title,
    section,
    lang: 'en',
    headings: headings.map(h => h.text),
    html: bodyHtml,
  });
}

for (const p of pages) {
  const { html, headings } = await renderMdx(p.body, { tableLabel: p.data.title });
  const cards =
    p.slug === 'index'
      ? `<h2 id="topics">Topics</h2><ul class="cards">${pages
          .filter(x => x.slug !== 'index')
          .map(
            x =>
              `<li><a href="${url(x.slug)}">${esc(x.data.title)}</a><p class="muted">${esc(x.data.description)}</p></li>`
          )
          .join(
            ''
          )}<li><a href="${url(REF.slug)}">${esc(REF.title)}</a><p class="muted">${esc(REF.description)}</p></li></ul>`
      : '';
  enPage({
    slug: p.slug,
    title: p.data.title,
    description: p.data.description,
    section: p.data.section ?? 'Docs',
    main: `<h1>${esc(p.data.title)}</h1>${html}${cards}`,
    headings,
    bodyHtml: html + cards,
  });
}

// Generated API reference page.
{
  const { html, toc } = renderOpenApi(spec, EN.openapi, `${spec.servers?.[1]?.url ?? ''}`);
  const intro = `<p>${esc(REF.description)} The raw document is available as <a href="/openapi.json"><code>/openapi.json</code></a> (OpenAPI ${esc(spec.openapi)}).</p>
<aside class="callout callout-soon"><strong>Coverage</strong><p>${coverage.operations} operations are annotated out of roughly ${coverage.handlers} route handlers in the API. Annotating the rest is tracked as a follow-up; for the endpoints that are not listed here, see the hand-written <a href="/storefront-api/">storefront</a> and <a href="/merchant-api/">merchant</a> API pages.</p></aside>`;
  enPage({
    slug: REF.slug,
    title: REF.title,
    description: REF.description,
    section: REF.section,
    main: `<h1>${esc(REF.title)}</h1>${intro}${html}`,
    headings: toc,
    bodyHtml: intro + html,
  });
}

// Arabic landing page.
{
  const { html } = await renderMdx(arIndex.body, { tableLabel: arIndex.data.title });
  const cards = `<ul class="cards" dir="ltr" lang="en">${pages
    .filter(x => x.slug !== 'index')
    .map(
      x =>
        `<li><a href="${url(x.slug)}">${esc(x.data.title)}</a><p class="muted">${esc(x.data.description)}</p></li>`
    )
    .join('')}</ul>`;
  const page = renderPage({
    lang: 'ar',
    title: `وثائق ${BRAND.company.shortNameAr}`,
    description: arIndex.data.description,
    canonical: ORIGIN + '/ar/',
    alternates: [
      { hreflang: 'en', href: ORIGIN + '/' },
      { hreflang: 'ar', href: ORIGIN + '/ar/' },
    ],
    siteLabel: 'وثائق المطوّرين',
    active: 'docs',
    homeHref: '/ar/',
    langSwitch: { href: '/', label: 'English', lang: 'en' },
    search: {
      action: '/search/',
      label: 'بحث',
      placeholder: 'ابحث في الوثائق (بالإنجليزية)',
      index: '/search-index.en.json',
    },
    main: `<article class="prose"><h1>${esc(arIndex.data.title)}</h1>${html}${cards}</article>`,
    footer: renderFooter({
      copy: `© ${new Date().getUTCFullYear()} ${BRAND.company.shortNameAr}.`,
      links: [{ href: `mailto:${BRAND.supportEmail}`, label: BRAND.supportEmail }],
    }),
    skipLabel: 'تخطَّ إلى المحتوى',
  });
  writePage(out, '/ar/', page);
}

// Search page + index.
writePage(
  out,
  '/search/',
  renderPage({
    lang: 'en',
    title: `Search | ${BRAND.company.shortNameEn} Docs`,
    description: 'Search the Ebda Store developer documentation.',
    canonical: ORIGIN + '/search/',
    siteLabel: EN.site,
    homeHref: '/',
    active: 'docs',
    langSwitch: { href: '/ar/', label: 'العربية', lang: 'ar' },
    search: EN.search,
    sidebar: sidebarFor(''),
    main: `<div class="prose">${renderSearchMain({
      lang: 'en',
      title: 'Search',
      intro: 'Type to search every page of the docs.',
      indexUrl: '/search-index.en.json',
      messages: {
        loading: 'Loading the search index…',
        none: 'No results.',
        count: '{n} results',
        error: 'The search index could not be loaded.',
        noscript: 'Search needs JavaScript. You can browse the topics from the sidebar instead.',
      },
    })}</div>`,
    footer,
    scripts: ['/assets/search.js'],
    skipLabel: EN.skip,
  }).replace('<head>', '<head>\n<meta name="robots" content="noindex">')
);
await writeSearchAssets(out, searchDocs);

writeSeoFiles(out, ORIGIN, urls);
// 404 pages: Workers Static Assets serves the NEAREST 404.html (/ar/* gets the Arabic one). Apple-style: one calm
// sentence, live search, a compact map. The docs are English-only, so the Arabic page searches the English index.
const NF = {
  en: {
    line: "The page you're looking for can't be found.",
    hint: 'Search for what you meant, or pick a section below.',
    mapLabel: 'Documentation sections',
    docs: 'Documentation',
    ebda: BRAND.company.shortNameEn,
    home: 'Docs home',
    contact: 'Contact',
  },
  ar: {
    line: 'الصفحة اللي بتدوّر عليها مش موجودة.',
    hint: 'دوّر على اللي كنت تقصده (الوثائق بالإنجليزية)، أو اختار قسم من تحت.',
    mapLabel: 'أقسام الوثائق',
    docs: 'الوثائق',
    ebda: BRAND.company.shortNameAr,
    home: 'الصفحة الرئيسية للوثائق',
    contact: 'تواصل معانا',
  },
};
const firstOfSection = SECTIONS.flatMap(section => {
  const first = allNav
    .filter(p => p.section === section)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))[0];
  return first ? [{ label: section, href: url(first.slug) }] : [];
});
for (const lang of ['en', 'ar']) {
  const c = NF[lang];
  const ar = lang === 'ar';
  writeFileSync(
    path.join(out, ar ? 'ar/404.html' : '404.html'),
    renderPage({
      lang,
      title: ar
        ? `الصفحة مش موجودة | وثائق المطوّرين`
        : `Not found | ${BRAND.company.shortNameEn} Docs`,
      description: ar ? 'الصفحة مش موجودة.' : 'Page not found.',
      canonical: ORIGIN + (ar ? '/ar/' : '/'),
      siteLabel: ar ? 'وثائق المطوّرين' : EN.site,
      homeHref: ar ? '/ar/' : '/',
      active: 'docs',
      search: ar
        ? {
            action: '/search/',
            label: 'بحث',
            placeholder: 'ابحث في الوثائق (بالإنجليزية)',
            index: '/search-index.en.json',
          }
        : EN.search,
      noHeaderSearch: true,
      main: render404Main({
        lang,
        search: ar
          ? {
              action: '/search/',
              label: 'بحث',
              placeholder: 'ابحث في الوثائق (بالإنجليزية)',
              index: '/search-index.en.json',
            }
          : EN.search,
        line: c.line,
        hint: c.hint,
        mapLabel: c.mapLabel,
        groups: [
          {
            title: c.docs,
            links: [
              { href: ar ? '/ar/' : '/', label: c.home },
              ...firstOfSection,
              { href: '/openapi.json', label: 'OpenAPI' },
            ],
          },
          {
            title: c.ebda,
            links: [
              ...siteNavItems(lang).map(i => ({ href: i.href, label: i.label })),
              { href: `mailto:${BRAND.supportEmail}`, label: c.contact },
            ],
          },
        ],
      }),
      footer,
      skipLabel: ar ? 'تخطَّ إلى المحتوى' : EN.skip,
    }).replace('<head>', '<head>\n<meta name="robots" content="noindex">')
  );
}
writeFileSync(
  path.join(out, 'llms.txt'),
  `# ${BRAND.company.shortNameEn} Docs\n\n> Developer documentation for ${BRAND.product.nameEn}, from ${BRAND.company.shortNameEn}. Products are added here as they ship.\n\n${pages
    .map(p => `- [${p.data.title}](${ORIGIN}${url(p.slug)}): ${p.data.description}`)
    .join('\n')}\n- [OpenAPI document](${ORIGIN}/openapi.json)\n`
);
console.log(`docs built: ${urls.length} pages -> ${out}`);
