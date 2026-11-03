// Static build for help.ebda.app: in-repo MDX articles, Arabic-first (/) + English (/en/),
// with a build-time MiniSearch index searched client-side. Every article may link back to
// store.ebda.app via `appPath` frontmatter.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, BRAND_STORE_APP_URL, BRAND_MARKETING_URL, siteNavMap } from '@ebda/shared/brand';
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
import { assertNoBrokenLinks } from '@ebda/site-kit/build/links';
import { writeSearchAssets } from '@ebda/site-kit/build/search';
import { loadContent, resetOut, writePage } from '@ebda/site-kit/build/site';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
const ORIGIN = `https://${BRAND.domains.help}`;

const L = {
  ar: {
    prefix: '',
    site: `مركز مساعدة ${BRAND.company.shortNameAr}`,
    skip: 'تخطَّ إلى المحتوى',
    homeTitle: `مركز مساعدة ${BRAND.company.shortNameAr}`,
    homeIntro:
      'إجابات واضحة وصادقة عن إنشاء متجرك وإدارته. اللي لسه مش جاهز في المنصة مكتوب عليه «قريباً».',
    homeCta: 'أنشئ متجرك',
    cardsTitle: 'المواضيع',
    soon: 'قريباً',
    openApp: 'افتح لوحة التحكم',
    tocLabel: 'في هذه الصفحة',
    sidebarLabel: 'المقالات',
    search: { action: '/search/', label: 'بحث', placeholder: 'ابحث في المساعدة' },
    switch: { label: 'English', lang: 'en' },
    searchMsgs: {
      loading: 'جارٍ تحميل فهرس البحث…',
      none: 'لا توجد نتائج.',
      count: '{n} نتيجة',
      error: 'تعذّر تحميل فهرس البحث.',
      noscript: 'البحث يحتاج جافاسكريبت. تصفّح المقالات من القائمة بدلاً من ذلك.',
      title: 'بحث',
      intro: 'اكتب كلمة للبحث في كل المقالات.',
    },
    notFound: ['الصفحة غير موجودة', 'الصفحة دي مش موجودة. ارجع إلى'],
    homeLink: 'الصفحة الرئيسية',
  },
  en: {
    prefix: '/en',
    site: `${BRAND.company.shortNameEn} Help`,
    skip: 'Skip to content',
    homeTitle: `${BRAND.company.shortNameEn} Help`,
    homeIntro:
      'Straight answers about creating and running your store. Anything not built yet is marked "Coming soon".',
    homeCta: 'Create your store',
    cardsTitle: 'Topics',
    soon: 'Coming soon',
    openApp: 'Open the dashboard',
    tocLabel: 'On this page',
    sidebarLabel: 'Articles',
    search: { action: '/en/search/', label: 'Search', placeholder: 'Search help' },
    switch: { label: 'العربية', lang: 'ar' },
    searchMsgs: {
      loading: 'Loading the search index…',
      none: 'No results.',
      count: '{n} results',
      error: 'The search index could not be loaded.',
      noscript: 'Search needs JavaScript. Browse the articles from the menu instead.',
      title: 'Search',
      intro: 'Type a word to search every article.',
    },
    notFound: ['Page not found', 'That page does not exist. Go to the'],
    homeLink: 'help home',
  },
};

const homeUrl = lang => (lang === 'ar' ? '/' : '/en/');
const articleUrl = (lang, slug) => `${L[lang].prefix}/${slug}/`;

resetOut(out, path.join(root, 'public'));
writeSiteCss(out);

// Product folders (BRAND-ARCH-1, LAUNCH-SUITE-1): content/<lang>/<folder>/<slug>.mdx builds to /<folder>/<slug>/
// (and /en/<folder>/<slug>/). Ebda Store's own articles stay at the root; each further product is one folder.
const PRODUCT_FOLDERS = [
  {
    id: 'whatsapp',
    name: { ar: 'ابدأ شات', en: 'Ebda Chat' },
  },
];
const PRODUCT_NAME = {
  store: { ar: BRAND.product.nameAr, en: BRAND.product.nameEn },
  ...Object.fromEntries(PRODUCT_FOLDERS.map(f => [f.id, f.name])),
};
const loadLang = lang => [
  ...loadContent(path.join(root, 'content', lang)).map(a => ({
    ...a,
    product: 'store',
    path: a.slug,
  })),
  ...PRODUCT_FOLDERS.flatMap(f =>
    existsSync(path.join(root, 'content', lang, f.id))
      ? loadContent(path.join(root, 'content', lang, f.id)).map(a => ({
          ...a,
          product: f.id,
          path: `${f.id}/${a.slug}`,
        }))
      : []
  ),
];
const content = { ar: loadLang('ar'), en: loadLang('en') };
// Both languages must carry the same article set (parity is part of "Arabic-first + English").
const slugs = a => a.map(x => x.path).join(',');
if (slugs(content.ar) !== slugs(content.en)) {
  throw new Error(
    `Article sets differ between ar and en:\n ar: ${slugs(content.ar)}\n en: ${slugs(content.en)}`
  );
}

const searchDocs = [];
const urls = [];

const sidebarFor = (lang, current) => {
  const groups = new Map();
  for (const a of content[lang]) {
    const g = a.data.section ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({
      href: articleUrl(lang, a.path),
      label: a.data.title + (a.data.status === 'soon' ? ` (${L[lang].soon})` : ''),
      current: a.path === current,
    });
  }
  return renderSidebar(
    [...groups].map(([title, items]) => ({ title, items })),
    L[lang].sidebarLabel
  );
};

const base = lang => {
  const c = L[lang];
  const other = lang === 'ar' ? 'en' : 'ar';
  return {
    lang,
    siteLabel: c.site,
    homeHref: homeUrl(lang),
    active: 'help',
    search: c.search,
    skipLabel: c.skip,
    footer: renderFooter({ lang }),
    langSwitch: { label: L[other].switch.label, lang: other },
  };
};

const alternates = (arPath, enPath) => [
  { hreflang: 'ar', href: ORIGIN + arPath },
  { hreflang: 'en', href: ORIGIN + enPath },
  { hreflang: 'x-default', href: ORIGIN + arPath },
];

for (const lang of ['ar', 'en']) {
  const c = L[lang];
  const other = lang === 'ar' ? 'en' : 'ar';

  // Home
  const cardsFor = product =>
    content[lang]
      .filter(a => a.product === product)
      .map(
        a =>
          `<li><a href="${articleUrl(lang, a.path)}">${esc(a.data.title)}</a>${a.data.status === 'soon' ? ` <span class="badge">${esc(c.soon)}</span>` : ''}<p class="muted">${esc(a.data.description)}</p></li>`
      )
      .join('');
  // One section per product (BRAND-ARCH-1). Ebda Store is the only live product; the others get their own
  // section the day they ship, never a "coming soon" card.
  const homeMain = `<div class="prose"><h1>${esc(c.homeTitle)}</h1><p>${esc(c.homeIntro)}</p><p><a class="btn" href="${BRAND_STORE_APP_URL}/signup">${esc(c.homeCta)}</a></p>${Object.keys(
    PRODUCT_NAME
  )
    .filter(id => content[lang].some(a => a.product === id))
    .map(
      id =>
        `<section aria-labelledby="p-${id}"><h2 id="p-${id}">${esc(PRODUCT_NAME[id][lang])}</h2><ul class="cards">${cardsFor(id)}</ul></section>`
    )
    .join('')}</div>`;
  writePage(
    out,
    homeUrl(lang),
    renderPage({
      ...base(lang),
      title: c.homeTitle,
      description: c.homeIntro,
      canonical: ORIGIN + homeUrl(lang),
      alternates: alternates('/', '/en/'),
      langSwitch: { ...base(lang).langSwitch, href: homeUrl(other) },
      main: homeMain,
    })
  );
  urls.push(homeUrl(lang));

  // Articles
  for (const a of content[lang]) {
    const { html, headings } = await renderMdx(a.body, { tableLabel: a.data.title });
    const soon = a.data.status === 'soon' ? `<p><span class="badge">${esc(c.soon)}</span></p>` : '';
    const appLink = a.data.appPath
      ? `<p><a class="btn btn-ghost" href="${esc(BRAND_STORE_APP_URL + a.data.appPath)}">${esc(c.openApp)}</a></p>`
      : '';
    const main = `<article class="prose"><p class="muted small">${esc(PRODUCT_NAME[a.product][lang])}</p><h1>${esc(a.data.title)}</h1>${soon}${renderToc(headings, c.tocLabel)}${html}${appLink}</article>`;
    writePage(
      out,
      articleUrl(lang, a.path),
      renderPage({
        ...base(lang),
        title: `${a.data.title} | ${c.site}`,
        description: a.data.description,
        canonical: ORIGIN + articleUrl(lang, a.path),
        alternates: alternates(articleUrl('ar', a.path), articleUrl('en', a.path)),
        langSwitch: { ...base(lang).langSwitch, href: articleUrl(other, a.path) },
        sidebar: sidebarFor(lang, a.path),
        main,
      })
    );
    urls.push(articleUrl(lang, a.path));
    searchDocs.push({
      url: articleUrl(lang, a.path),
      title: a.data.title,
      section: a.data.section ?? c.site,
      lang,
      headings: headings.map(h => h.text),
      html: html + (a.data.keywords ? ` ${a.data.keywords}` : ''),
    });
  }

  // Search page
  const sp = `${c.prefix}/search/`;
  writePage(
    out,
    sp,
    renderPage({
      ...base(lang),
      title: `${c.searchMsgs.title} | ${c.site}`,
      description: c.searchMsgs.intro,
      canonical: ORIGIN + sp,
      langSwitch: { ...base(lang).langSwitch, href: `${L[other].prefix}/search/` },
      sidebar: sidebarFor(lang, ''),
      main: `<div class="prose">${renderSearchMain({
        lang,
        title: c.searchMsgs.title,
        intro: c.searchMsgs.intro,
        indexUrl: `/search-index.${lang}.json`,
        messages: c.searchMsgs,
      })}</div>`,
      scripts: ['/assets/search.js'],
    }).replace('<head>', '<head>\n<meta name="robots" content="noindex">')
  );
}

await writeSearchAssets(out, searchDocs);
writeSeoFiles(out, ORIGIN, urls);
// 404 pages, one per language: Workers Static Assets serves the NEAREST 404.html, so /en/* gets the English one.
// Apple-style: one calm sentence, live search, a compact map of the sections. Status stays 404 (not_found_handling).
const NF = {
  ar: {
    line: 'الصفحة اللي بتدوّر عليها مش موجودة.',
    hint: 'دوّر على اللي كنت تقصده، أو اختار قسم من تحت.',
    mapLabel: 'أقسام مركز المساعدة',
    sections: 'أقسام المساعدة',
    ebda: BRAND.company.shortNameAr,
    links: { home: 'الصفحة الرئيسية للمساعدة' },
  },
  en: {
    line: "The page you're looking for can't be found.",
    hint: 'Search for what you meant, or pick a section below.',
    mapLabel: 'Help sections',
    sections: 'Help sections',
    ebda: BRAND.company.shortNameEn,
    links: { home: 'Help home' },
  },
};
for (const lang of ['ar', 'en']) {
  const c = NF[lang];
  const firstOfSection = new Map();
  for (const a of content[lang]) {
    const g = a.data.section ?? '';
    if (g && !firstOfSection.has(g)) firstOfSection.set(g, articleUrl(lang, a.path));
  }
  writeFileSync(
    path.join(out, lang === 'ar' ? '404.html' : 'en/404.html'),
    renderPage({
      ...base(lang),
      title: `${L[lang].notFound[0]} | ${L[lang].site}`,
      description: L[lang].notFound[0],
      canonical: ORIGIN + (lang === 'ar' ? '/' : '/en/'),
      langSwitch: undefined,
      noHeaderSearch: true,
      main: render404Main({
        lang,
        search: L[lang].search,
        line: c.line,
        hint: c.hint,
        mapLabel: c.mapLabel,
        groups: [
          {
            title: c.sections,
            links: [...firstOfSection].map(([label, href]) => ({ label, href })),
          },
          {
            title: c.ebda,
            links: [
              { href: homeUrl(lang), label: c.links.home },
              ...siteNavMap(lang)
                .filter(i => i.id !== 'help')
                .map(i => ({ href: i.href, label: i.label })),
            ],
          },
        ],
      }),
    }).replace('<head>', '<head>\n<meta name="robots" content="noindex">')
  );
}
writeFileSync(
  path.join(out, 'llms.txt'),
  `# ${BRAND.company.shortNameEn} Help\n\n> Merchant help for ${BRAND.product.nameEn}, in Arabic and English. Products are added here as they ship.\n\n${content.en
    .map(a => `- [${a.data.title}](${ORIGIN}${articleUrl('en', a.path)}): ${a.data.description}`)
    .join('\n')}\n`
);
assertNoBrokenLinks(out, ORIGIN);
console.log(
  `help built: ${urls.length} pages (${content.en.length} articles x 2 locales) -> ${out}`
);
