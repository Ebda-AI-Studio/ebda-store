// Public status page: server-rendered HTML, inline CSS, NO JavaScript, no external requests.
import {
  BRAND,
  BRAND_MARKETING_URL,
  SITE_NAV_CSS,
  brandMarkSvg,
  brandAppIconSvg,
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
    skip: 'تخطَّ إلى المحتوى',
    overall: {
      operational: 'كل الأنظمة تعمل بشكل طبيعي',
      degraded: 'بعض الخدمات تعمل بأداء منخفض',
      outage: 'هناك انقطاع في بعض الخدمات',
      unknown: 'لا توجد بيانات بعد',
    },
    status: {
      operational: 'يعمل',
      degraded: 'أداء منخفض',
      outage: 'متوقف',
      unknown: 'لا بيانات',
    },
    components: 'الخدمات',
    uptime: (p: string, d: number) => `نسبة التوفر آخر ${d} يوماً: ${p}`,
    noData: 'لا بيانات',
    activeIncidents: 'الأحداث الجارية',
    recentIncidents: 'آخر الأحداث (14 يوماً)',
    none: 'لا توجد أحداث.',
    updates: 'التحديثات',
    inc: {
      investigating: 'قيد التحقيق',
      identified: 'تم تحديد السبب',
      monitoring: 'قيد المراقبة',
      resolved: 'تم الحل',
    },
    checked: 'آخر فحص',
    generated: 'آخر تحديث للصفحة',
    explain:
      'نفحص كل خدمة كل دقيقة من خارج منصتنا. يُفتح حدث تلقائياً بعد عدة فحوصات فاشلة متتالية ويُغلق بعد عودة الخدمة.',
    bars: 'كل شريط يوم واحد (بالتوقيت العالمي)، من الأقدم إلى الأحدث.',
    days: 'الأيام',
    otherLang: { href: '/en', label: 'English', lang: 'en' },
    // a function of the YEAR: a module-level `new Date()` is evaluated while the Worker's clock is frozen at 0 (1970)
    footer: (year: number) => `© ${year} ${BRAND.company.shortNameAr}`,
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
    footer: (year: number) => `© ${year} ${BRAND.company.shortNameEn}`,
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
  return `<li class="comp">
<div class="comp-head"><h3>${esc(name)}</h3><span class="pill ${c.status}"><span class="dot" aria-hidden="true"></span>${esc(t.status[c.status])}</span></div>
${bars(c, lang)}
<p class="muted small">${esc(t.uptime(up, HISTORY_DAYS))}${checked}</p>
</li>`;
}

function incident(i: Incident, lang: Lang): string {
  const t = T[lang];
  const title = lang === 'ar' && i.titleAr ? i.titleAr : i.title;
  const cfg = i.component ? COMPONENTS.find(c => c.id === i.component) : null;
  return `<li class="inc inc-${i.impact}">
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
:root{--night:${BRAND.colors.night};--gold:${BRAND.colors.gold};--lift:${BRAND.colors.lift};--panel:#121415;--raise:#181b1c;--line:#2f3435;--fg:#f3f5f4;--muted:#a9b1af;--ok:#5fd08a;--warn:#e6b450;--bad:#ff8a80}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--night);color:var(--fg);font-family:${BRAND.fonts.stacks.sans};line-height:1.65}
html[lang=ar] body{font-family:${BRAND.fonts.stacks.arabic};line-height:1.85}
a{color:var(--lift);text-underline-offset:3px}a:hover{color:var(--fg)}
:focus-visible{outline:3px solid var(--lift);outline-offset:3px;border-radius:4px}
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
.tag{border:1px solid var(--gold);color:var(--lift);border-radius:999px;padding:0 8px;font-size:.78rem}
.upd{margin-top:8px}.upd li{padding:6px 0;border-top:1px solid var(--line)}
footer{border-top:1px solid var(--line);margin-top:48px;padding-block:20px}
`.replace(/\n/g, '') + SITE_NAV_CSS;

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

export function renderStatusPage(s: Snapshot, lang: Lang, origin: string): string {
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
${siteNavHtml(lang, 'status')}
<a class="lang" href="${alt}" hreflang="${t.otherLang.lang}" lang="${t.otherLang.lang}">${t.otherLang.label}</a>
</div></header>
<main id="main" class="wrap">
<div class="banner ${s.overall}" role="status"><span class="dot" aria-hidden="true"></span><h1>${esc(t.overall[s.overall])}</h1></div>
<p class="muted small">${esc(t.explain)} ${esc(t.bars)}</p>
<h2>${esc(t.activeIncidents)}</h2>
${active}
<h2>${esc(t.components)}</h2>
${PRODUCTS.map(prod => {
  const list = s.components.filter(c => COMPONENTS.find(x => x.id === c.id)?.product === prod.id);
  return list.length
    ? `<section class="prod" aria-labelledby="prod-${prod.id}"><h3 id="prod-${prod.id}">${esc(prod.name[lang])}</h3><ul class="comps">${list.map(c => component(c, lang)).join('')}</ul></section>`
    : '';
}).join('')}
<h2>${esc(t.recentIncidents)}</h2>
${recent}
<p class="muted small">${esc(t.generated)}: <time datetime="${new Date(s.generatedAt).toISOString()}">${fmt(s.generatedAt)}</time> · <a href="/api/status.json">/api/status.json</a></p>
</main>
<footer><div class="wrap muted small">${esc(t.footer(new Date(s.generatedAt).getUTCFullYear()))} · <a href="https://${BRAND.domains.help}">${lang === 'ar' ? 'مركز المساعدة' : 'Help centre'}</a> · <a href="https://${BRAND.domains.docs}">${lang === 'ar' ? 'الوثائق' : 'Docs'}</a></div></footer>
</body>
</html>
`;
}

export type { ComponentStatus };
