// Public status page: server-rendered HTML and inline CSS; it works with NO JavaScript. The only script is the
// optional live search box (served from this same Worker, /assets/typeahead.js): without it the box is a plain GET form.
import {
  BRAND,
  BRAND_MARKETING_URL,
  SITE_ART_CSS,
  SITE_FOOTER_CSS,
  SITE_NAV_CSS,
  brandMarkSvg,
  brandAppIconSvg,
  siteFooterHtml,
  siteMedalHtml,
  siteNavHtml,
  siteWordmarkHtml,
} from '../../../packages/shared/src/brand/index';
import { COMPONENTS, HISTORY_DAYS, PRODUCTS } from './config';
import type { ComponentSnapshot, ComponentStatus, Incident, Snapshot } from './types';

export type Lang = 'ar' | 'en';

const T = {
  ar: {
    title: `حالة خدمات ${BRAND.company.shortNameAr}`,
    site: 'حالة الخدمة',
    skip: 'روح للمحتوى',
    overall: {
      operational: 'كل الخدمات شغّالة عادي',
      degraded: 'فيه خدمات شغّالة ببطء',
      outage: 'فيه خدمات واقفة دلوقتي',
      unknown: 'لسه مفيش بيانات',
    },
    status: {
      operational: 'شغّال',
      degraded: 'بطيء',
      outage: 'واقف',
      unknown: 'مفيش بيانات',
    },
    components: 'الخدمات',
    uptime: (p: string, d: number) => `نسبة التشغيل في آخر ${d} يوم: ${p}`,
    noData: 'مفيش بيانات',
    activeIncidents: 'مشاكل لسه مفتوحة',
    recentIncidents: 'آخر المشاكل (14 يوم)',
    none: 'مفيش مشاكل.',
    updates: 'التحديثات',
    inc: {
      investigating: 'بندوّر على السبب',
      identified: 'عرفنا السبب',
      monitoring: 'بنتابع',
      resolved: 'اتحلّت',
    },
    checked: 'آخر فحص',
    generated: 'آخر تحديث للصفحة',
    explain:
      'بنفحص كل خدمة كل دقيقة من برّه منصتنا. لو كذا فحص ورا بعض فشلوا بنفتح مشكلة لوحدها، وبنقفلها أول ما الخدمة ترجع.',
    bars: 'كل شريط يوم واحد (بتوقيت جرينتش)، من الأقدم للأحدث.',
    days: 'الأيام',
    otherLang: { href: '/en', label: 'English', lang: 'en' },
    // a function of the YEAR: a module-level `new Date()` is evaluated while the Worker's clock is frozen at 0 (1970)
  },
  en: {
    title: `${BRAND.company.shortNameEn} Status`,
    site: 'Status',
    skip: 'Skip to content',
    overall: {
      operational: 'All systems operational',
      degraded: 'Some services are degraded',
      outage: 'Some services are down',
      unknown: 'No data yet',
    },
    status: {
      operational: 'Operational',
      degraded: 'Degraded',
      outage: 'Outage',
      unknown: 'No data',
    },
    components: 'Services',
    uptime: (p: string, d: number) => `${d}-day uptime: ${p}`,
    noData: 'no data',
    activeIncidents: 'Active incidents',
    recentIncidents: 'Recent incidents (14 days)',
    none: 'No incidents.',
    updates: 'Updates',
    inc: {
      investigating: 'Investigating',
      identified: 'Identified',
      monitoring: 'Monitoring',
      resolved: 'Resolved',
    },
    checked: 'Last checked',
    generated: 'Page generated',
    explain:
      'Every service is probed once a minute from outside our platform. An incident opens automatically after several consecutive failed probes and resolves after the service recovers.',
    bars: 'Each bar is one UTC day, oldest to newest.',
    days: 'days',
    otherLang: { href: '/', label: 'العربية', lang: 'ar' },
  },
} as const;

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );

const fmt = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const barClass = (checks: number, ok: number): string => {
  if (!checks) return 'nd';
  const p = ok / checks;
  return p >= 0.995 ? 'up' : p >= 0.95 ? 'part' : 'down';
};

function bars(c: ComponentSnapshot, lang: Lang): string {
  return `<div class="bars" aria-hidden="true">${c.days
    .map(d => {
      const label = d.checks
        ? `${d.day}: ${((d.ok / d.checks) * 100).toFixed(2)}%`
        : `${d.day}: ${T[lang].noData}`;
      return `<span class="b ${barClass(d.checks, d.ok)}" title="${esc(label)}"></span>`;
    })
    .join('')}</div>`;
}

function component(c: ComponentSnapshot, lang: Lang): string {
  const t = T[lang];
  const cfg = COMPONENTS.find(x => x.id === c.id);
  const name = cfg ? cfg.name[lang] : c.id;
  const up = c.uptime === null ? t.noData : `${c.uptime.toFixed(2)}%`;
  const checked = c.lastChecked
    ? ` · ${t.checked}: <time datetime="${new Date(c.lastChecked).toISOString()}">${fmt(c.lastChecked)}</time>`
    : '';
  return `<li class="comp" id="c-${esc(c.id)}">
<div class="comp-head"><h3>${esc(name)}</h3><span class="pill ${c.status}"><span class="dot" aria-hidden="true"></span>${esc(t.status[c.status])}</span></div>
${bars(c, lang)}
<p class="muted small">${esc(t.uptime(up, HISTORY_DAYS))}${checked}</p>
</li>`;
}

function incident(i: Incident, lang: Lang): string {
  const t = T[lang];
  const title = lang === 'ar' && i.titleAr ? i.titleAr : i.title;
  const cfg = i.component ? COMPONENTS.find(c => c.id === i.component) : null;
  return `<li class="inc inc-${i.impact}" id="i-${i.id}">
<h3>${esc(title)}</h3>
<p class="muted small"><span class="tag">${esc(t.inc[i.status])}</span> ${cfg ? esc(cfg.name[lang]) + ' · ' : ''}<time datetime="${new Date(i.openedAt).toISOString()}">${fmt(i.openedAt)}</time></p>
<ul class="upd">${i.updates
    .map(u => {
      const body = lang === 'ar' && u.bodyAr ? u.bodyAr : u.body;
      return `<li><strong>${esc(t.inc[u.status])}</strong> <time class="muted small" datetime="${new Date(u.at).toISOString()}">${fmt(u.at)}</time><br>${esc(body)}</li>`;
    })
    .join('')}</ul>
</li>`;
}

const CSS =
  `
:root{--night:${BRAND.colors.night};--gold:${BRAND.colors.gold};--lift:${BRAND.colors.lift};--canvas:#fafafa;--panel:#ffffff;--raise:#f2f2f2;--line:#e2e3e3;--fg:#121314;--muted:#575c5d;--accent-text:color-mix(in srgb,var(--gold) 70%,#000);--ok:#0d7a43;--warn:#8a5a00;--bad:#b42318}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--canvas);color:var(--fg);font-family:${BRAND.fonts.stacks.sans};line-height:1.65}
html[lang=ar] body{font-family:${BRAND.fonts.stacks.arabic};line-height:1.85}
a{color:var(--accent-text);text-underline-offset:3px}a:hover{color:var(--fg)}
:focus-visible{outline:3px solid var(--fg);outline-offset:3px;border-radius:4px}
.wrap{max-width:860px;margin-inline:auto;padding-inline:16px}
.skip{position:absolute;inset-inline-start:8px;top:-80px;background:var(--lift);color:var(--night);padding:10px 14px;border-radius:8px;font-weight:600}
.skip:focus{top:8px;color:var(--night)}
header{border-bottom:1px solid var(--line);overflow-x:clip}
.header-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;padding-block:12px}.wm-site{color:var(--muted);font-size:.9rem;border-inline-start:1px solid var(--line);padding-inline-start:8px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-block:12px}
.wordmark{display:inline-flex;gap:8px;align-items:center;color:var(--fg);text-decoration:none}
.wm-l{font-weight:600;letter-spacing:.01em}.wm-mk{flex:none}.wm-a{color:var(--lift)}.wm-s{color:var(--muted);font-size:.9rem;border-inline-start:1px solid var(--line);padding-inline-start:8px}
.lang{padding:6px 10px;border:1px solid var(--line);border-radius:10px;text-decoration:none}
h1{font-size:clamp(1.5rem,5vw,2.1rem);margin:0;line-height:1.3}
h2{font-size:1.3rem;margin:2em 0 .6em}h3{font-size:1.05rem;margin:0 0 .2em}
.banner{margin-block:28px 8px;padding:18px 20px;border-radius:14px;border:1px solid var(--line);background:var(--panel);display:flex;align-items:center;gap:12px}
.banner.operational{border-color:var(--ok)}.banner.degraded{border-color:var(--warn)}.banner.outage{border-color:var(--bad)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--muted)}
.operational .dot{background:var(--ok)}.degraded .dot{background:var(--warn)}.outage .dot{background:var(--bad)}
.muted{color:var(--muted)}.small{font-size:.875rem}
.prod h3{font-size:.95rem;margin:1.2em 0 .5em;color:var(--muted)}.comps,.incs,.upd{list-style:none;padding:0;margin:0}
.comp{min-width:0;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--panel)}
.comp-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:.875rem;font-weight:600}
.pill.operational{color:var(--ok)}.pill.degraded{color:var(--warn)}.pill.outage{color:var(--bad)}.pill.unknown{color:var(--muted)}
.bars{display:flex;gap:2px;height:30px;direction:ltr;margin-bottom:6px;min-width:0;overflow:hidden}
.b{flex:1 1 0;min-width:2px;border-radius:2px;background:var(--line)}
.b.up{background:var(--ok)}.b.part{background:var(--warn)}.b.down{background:var(--bad)}
.inc{border:1px solid var(--line);border-inline-start:4px solid var(--warn);border-radius:10px;padding:12px 16px;margin-bottom:12px;background:var(--panel)}
.inc-outage{border-inline-start-color:var(--bad)}
.tag{border:1px solid var(--gold);color:var(--accent-text);border-radius:999px;padding:0 8px;font-size:.78rem}
.upd{margin-top:8px}.upd li{padding:6px 0;border-top:1px solid var(--line)}
.sr-only{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.search{position:relative;display:flex;gap:6px;margin-inline-start:auto}
.search input{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-width:0;width:190px;font:inherit}
.search button{background:var(--gold);color:var(--night);border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
@media (max-width:640px){.header-row{flex-wrap:nowrap;gap:8px}.wordmark span{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.search{flex:1 1 0;min-inline-size:0;margin-inline-start:0}.search input{inline-size:100%;width:100%;min-block-size:44px}.search button{padding-inline:10px;min-block-size:44px}.lang{flex:none;padding-inline:8px;min-block-size:44px;display:inline-flex;align-items:center}}
.ta-list,.ta-note{position:absolute;inset-inline-end:0;top:calc(100% + 6px);z-index:30;inline-size:min(420px,calc(100vw - 32px));margin:0;padding:6px;list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.14);text-align:start}
.ta-note{padding:12px 14px;color:var(--muted)}
.ta-list[hidden],.ta-note[hidden]{display:none}
.ta-list a{display:flex;flex-direction:column;gap:2px;min-block-size:44px;justify-content:center;padding:8px 12px;border-radius:8px;color:var(--fg);text-decoration:none}
.ta-list a[aria-selected=true],.ta-list a:hover{background:var(--raise);outline:1px solid var(--gold)}
.ta-list mark{background:transparent;color:var(--accent-text);font-weight:700}
.ta-sec{color:var(--muted);font-size:.8125rem}
.ta-all{color:var(--muted)!important;font-size:.9rem}
`.replace(/\n/g, '') +
  SITE_NAV_CSS +
  SITE_FOOTER_CSS +
  SITE_ART_CSS;

const SEARCH = {
  ar: { label: 'بحث', placeholder: 'دوّر في الخدمات والأحداث والمساعدة' },
  en: { label: 'Search', placeholder: 'Search services, incidents and help' },
};
const HELP = `https://${BRAND.domains.help}`;

/** The header search: components + incidents from this Worker, and the help articles that mention the status page. */
function searchForm(lang: Lang): string {
  const c = SEARCH[lang];
  const sources = [
    `/search.json?lang=${lang}||docs`,
    `${HELP}/search-index.${lang}.json|${HELP}|index|${lang === 'ar' ? 'حالة,انقطاع,status' : 'status,outage,incident'}`,
  ].join(';');
  return `<form class="search" role="search" action="${HELP}${lang === 'ar' ? '' : '/en'}/search/" method="get" data-sources="${esc(sources)}">
<label class="sr-only" for="q">${esc(c.label)}</label>
<input id="q" name="q" type="search" placeholder="${esc(c.placeholder)}" autocomplete="off" enterkeyhint="search">
<button type="submit">${esc(c.label)}</button>
</form>`;
}

/**
 * The status page's own searchable content (components and incidents), localized: the live search loads it as
 * `/search.json` and indexes it in the browser. Hrefs are on-page anchors, so a result scrolls to the item.
 */
export function statusSearchDocs(s: Snapshot, lang: Lang) {
  const t = T[lang];
  const home = lang === 'ar' ? '/' : '/en';
  const comps = s.components.map(c => {
    const cfg = COMPONENTS.find(x => x.id === c.id);
    const product = PRODUCTS.find(p => p.id === cfg?.product);
    return {
      id: `${home}#c-${c.id}`,
      title: cfg ? cfg.name[lang] : c.id,
      section: product ? product.name[lang] : t.components,
      snippet: t.status[c.status],
    };
  });
  const incs = [...s.active, ...s.recent].map(i => ({
    id: `${home}#i-${i.id}`,
    title: lang === 'ar' && i.titleAr ? i.titleAr : i.title,
    section: t.recentIncidents,
    snippet:
      `${t.inc[i.status]} ${i.updates.map(u => (lang === 'ar' && u.bodyAr ? u.bodyAr : u.body)).join(' ')}`.slice(
        0,
        200
      ),
  }));
  return [...comps, ...incs];
}

/** Social card (og + twitter) and JSON-LD for the status page: the shared 1200x630 card, the studio as publisher. */
function socialHead(
  t: { title: string; explain: string; site: string },
  lang: Lang,
  origin: string,
  home: string
): string {
  const url = origin + (home === '/' ? '/' : home);
  const image = `${BRAND_MARKETING_URL}/og.png`;
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${BRAND_MARKETING_URL}/#organization`,
        name: lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn,
        url: BRAND_MARKETING_URL,
        logo: `${BRAND_MARKETING_URL}/icon-512.png`,
      },
      {
        '@type': 'WebSite',
        url,
        name: t.site,
        inLanguage: lang,
        publisher: { '@id': `${BRAND_MARKETING_URL}/#organization` },
      },
    ],
  }).replace(/</g, '\\u003c');
  return (
    `<meta property="og:title" content="${esc(t.title)}"><meta property="og:description" content="${esc(t.explain)}">` +
    `<meta property="og:url" content="${url}"><meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="${esc(t.site)}"><meta property="og:locale" content="${lang === 'ar' ? 'ar_EG' : 'en_US'}">` +
    `<meta property="og:image" content="${image}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` +
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(t.title)}">` +
    `<meta name="twitter:description" content="${esc(t.explain)}"><meta name="twitter:image" content="${image}">` +
    `<script type="application/ld+json">${ld}</script>`
  );
}

export function renderStatusPage(
  s: Snapshot,
  lang: Lang,
  origin: string,
  /** The Services dropdown + coming-soon Products rows (SERVICES-IA-1): the Worker var EBDA_SERVICE_LINES=on. */
  serviceLines = false
): string {
  const t = T[lang];
  const home = lang === 'ar' ? '/' : '/en';
  const alt = lang === 'ar' ? '/en' : '/';
  const icon = `data:image/svg+xml,${encodeURIComponent(brandAppIconSvg())}`;
  const active = s.active.length
    ? `<ul class="incs">${s.active.map(i => incident(i, lang)).join('')}</ul>`
    : `<p class="muted">${t.none}</p>`;
  const recent = s.recent.length
    ? `<ul class="incs">${s.recent.map(i => incident(i, lang)).join('')}</ul>`
    : `<p class="muted">${t.none}</p>`;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.explain)}">
<meta name="theme-color" content="${BRAND.colors.night}">
<link rel="canonical" href="${origin}${home === '/' ? '/' : home}">
<link rel="alternate" hreflang="ar" href="${origin}/">
<link rel="alternate" hreflang="en" href="${origin}/en">
<link rel="icon" href="${icon}">
${socialHead(t, lang, origin, home)}
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>
<header class="site-header"><div class="wrap header-row">
${siteWordmarkHtml({ lang, href: home, siteLabel: t.site, markHtml: brandMarkSvg({ size: 28, cls: 'wm-mk' }) })}
${siteNavHtml(lang, 'status', serviceLines)}
${searchForm(lang)}
<a class="lang" href="${alt}" hreflang="${t.otherLang.lang}" lang="${t.otherLang.lang}">${t.otherLang.label}</a>
</div></header>
<main id="main" class="wrap tess">
<div class="banner ${s.overall}" role="status"><span class="dot" aria-hidden="true"></span><h1>${esc(t.overall[s.overall])}</h1></div>
<p class="muted small">${esc(t.explain)} ${esc(t.bars)}</p>
<h2>${esc(t.activeIncidents)}</h2>
${active}
${siteMedalHtml('m8')}
<h2>${esc(t.components)}</h2>
${PRODUCTS.map(prod => {
  const list = s.components.filter(c => COMPONENTS.find(x => x.id === c.id)?.product === prod.id);
  return list.length
    ? `<section class="prod" aria-labelledby="prod-${prod.id}"><h3 id="prod-${prod.id}">${esc(prod.name[lang])}</h3><ul class="comps">${list.map(c => component(c, lang)).join('')}</ul></section>`
    : '';
}).join('')}
${siteMedalHtml('m12')}
<h2>${esc(t.recentIncidents)}</h2>
${recent}
<p class="muted small">${esc(t.generated)}: <time datetime="${new Date(s.generatedAt).toISOString()}">${fmt(s.generatedAt)}</time> · <a href="/api/status.json">/api/status.json</a></p>
</main>
${siteFooterHtml(lang, brandMarkSvg({ size: 24, cls: 'sf-mark' }), new Date(s.generatedAt).getUTCFullYear())}
<script src="/assets/site-nav.js" defer></script>
<script src="/assets/typeahead.js" defer></script>
</body>
</html>
`;
}

export type { ComponentStatus };
