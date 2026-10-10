// Static build for help.ebda.app: in-repo MDX articles, Arabic-first (/) + English (/en/),
// with a build-time MiniSearch index searched client-side. Every article may link back to
// store.ebda.app via `appPath` frontmatter.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, BRAND_STORE_APP_URL, BRAND_MARKETING_URL } from '@force/shared/brand';
import { renderMdx } from '@force/site-kit/build/mdx';
import {
  esc,
  renderFooter,
  renderPage,
  renderSearchMain,
  renderSidebar,
  renderToc,
  writeSeoFiles,
  writeSiteCss,
} from '@force/site-kit/build/shell';
import { writeSearchAssets } from '@force/site-kit/build/search';
import { loadContent, resetOut, writePage } from '@force/site-kit/build/site';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
const ORIGIN = `https://${BRAND.domains.help}`;

const L = {
  ar: {
    prefix: '',
    site: 'مركز المساعدة',
    skip: 'تخطَّ إلى المحتوى',
    homeTitle: `مركز مساعدة ${BRAND.product.nameAr}`,
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
    nav: [
      { href: BRAND_MARKETING_URL, label: BRAND.company.shortNameAr },
      { href: BRAND_STORE_APP_URL, label: 'لوحة التحكم' },
      { href: `https://${BRAND.domains.status}`, label: 'حالة الخدمة' },
    ],
    footer: `© ${new Date().getUTCFullYear()} ${BRAND.company.shortNameAr}. تحتاج مساعدة إضافية؟ راسلنا.`,
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
    site: 'Help centre',
    skip: 'Skip to content',
    homeTitle: `${BRAND.product.nameEn} help centre`,
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
    nav: [
      { href: BRAND_MARKETING_URL + '/en/', label: BRAND.company.shortNameEn },
      { href: BRAND_STORE_APP_URL, label: 'Dashboard' },
      { href: `https://${BRAND.domains.status}/en`, label: 'Status' },
    ],
    footer: `© ${new Date().getUTCFullYear()} ${BRAND.company.shortNameEn}. Need more help? Email us.`,
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

const content = {
  ar: loadContent(path.join(root, 'content', 'ar')),
  en: loadContent(path.join(root, 'content', 'en')),
};
// Both languages must carry the same article set (parity is part of "Arabic-first + English").
const slugs = a => a.map(x => x.slug).join(',');
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
      href: articleUrl(lang, a.slug),
      label: a.data.title + (a.data.status === 'soon' ? ` (${L[lang].soon})` : ''),
      current: a.slug === current,
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
    nav: c.nav,
    search: c.search,
    skipLabel: c.skip,
    footer: renderFooter({
      copy: c.footer,
      links: [
        { href: `mailto:${BRAND.supportEmail}`, label: BRAND.supportEmail },
        {
          href: `https://${BRAND.domains.status}`,
          label: lang === 'ar' ? 'حالة الخدمة' : 'Status',
        },
        { href: `${BRAND_MARKETING_URL}/privacy/`, label: lang === 'ar' ? 'الخصوصية' : 'Privacy' },
      ],
    }),
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
  const cards = content[lang]
    .map(
      a =>
        `<li><a href="${articleUrl(lang, a.slug)}">${esc(a.data.title)}</a>${a.data.status === 'soon' ? ` <span class="badge">${esc(c.soon)}</span>` : ''}<p class="muted">${esc(a.data.description)}</p></li>`
    )
    .join('');
  const homeMain = `<div class="prose"><h1>${esc(c.homeTitle)}</h1><p>${esc(c.homeIntro)}</p><p><a class="btn" href="${BRAND_STORE_APP_URL}/signup">${esc(c.homeCta)}</a></p><h2 id="topics">${esc(c.cardsTitle)}</h2><ul class="cards">${cards}</ul></div>`;
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
    const main = `<article class="prose"><h1>${esc(a.data.title)}</h1>${soon}${renderToc(headings, c.tocLabel)}${html}${appLink}</article>`;
    writePage(
      out,
      articleUrl(lang, a.slug),
      renderPage({
        ...base(lang),
        title: `${a.data.title} | ${c.site}`,
        description: a.data.description,
        canonical: ORIGIN + articleUrl(lang, a.slug),
        alternates: alternates(articleUrl('ar', a.slug), articleUrl('en', a.slug)),
        langSwitch: { ...base(lang).langSwitch, href: articleUrl(other, a.slug) },
        sidebar: sidebarFor(lang, a.slug),
        main,
      })
    );
    urls.push(articleUrl(lang, a.slug));
    searchDocs.push({
      url: articleUrl(lang, a.slug),
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
        indexUrl: '/search-index.json',
        messages: c.searchMsgs,
      })}</div>`,
      scripts: ['/assets/search.js'],
    }).replace('<head>', '<head>\n<meta name="robots" content="noindex">')
  );
}

await writeSearchAssets(out, searchDocs);
writeSeoFiles(out, ORIGIN, urls);
writeFileSync(
  path.join(out, '404.html'),
  renderPage({
    ...base('ar'),
    title: `${L.ar.notFound[0]} | ${L.ar.site}`,
    description: L.ar.notFound[0],
    canonical: ORIGIN + '/',
    main: `<h1>${L.ar.notFound[0]}</h1><p>${L.ar.notFound[1]} <a href="/">${L.ar.homeLink}</a>.</p><p lang="en" dir="ltr">${L.en.notFound[0]}. <a href="/en/">${L.en.homeLink}</a></p>`,
  })
);
writeFileSync(
  path.join(out, 'llms.txt'),
  `# ${BRAND.product.nameEn} help centre\n\n> Merchant help for ${BRAND.product.nameEn}, in Arabic and English.\n\n${content.en
    .map(a => `- [${a.data.title}](${ORIGIN}${articleUrl('en', a.slug)}): ${a.data.description}`)
    .join('\n')}\n`
);
console.log(
  `help built: ${urls.length} pages (${content.en.length} articles x 2 locales) -> ${out}`
);
