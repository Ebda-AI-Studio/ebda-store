// Public status page: server-rendered HTML, inline CSS, NO JavaScript, no external requests.
import { BRAND, brandMarkSvg } from '../../../packages/shared/src/brand/index';
import { COMPONENTS, HISTORY_DAYS } from './config';
import type { ComponentSnapshot, ComponentStatus, Incident, Snapshot } from './types';

export type Lang = 'ar' | 'en';

const T = {
  ar: {
    title: `حالة خدمات ${BRAND.nameAr}`,
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
    footer: `© ${new Date().getUTCFullYear()} ${BRAND.company}`,
  },
  en: {
    title: `${BRAND.name} service status`,
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
    footer: `© ${new Date().getUTCFullYear()} ${BRAND.company}`,
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

const CSS = `
:root{--night:${BRAND.colors.night};--gold:${BRAND.colors.gold};--lift:${BRAND.colors.lift};--panel:#121415;--raise:#181b1c;--line:#2f3435;--fg:#f3f5f4;--muted:#a9b1af;--ok:#5fd08a;--warn:#e6b450;--bad:#ff8a80}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--night);color:var(--fg);font-family:${BRAND.fonts.stacks.sans};line-height:1.65}
html[lang=ar] body{font-family:${BRAND.fonts.stacks.arabic};line-height:1.85}
a{color:var(--lift);text-underline-offset:3px}a:hover{color:var(--fg)}
:focus-visible{outline:3px solid var(--lift);outline-offset:3px;border-radius:4px}
.wrap{max-width:860px;margin-inline:auto;padding-inline:16px}
.skip{position:absolute;inset-inline-start:8px;top:-80px;background:var(--lift);color:var(--night);padding:10px 14px;border-radius:8px;font-weight:600}
.skip:focus{top:8px;color:var(--night)}
header{border-bottom:1px solid var(--line)}
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
.comps,.incs,.upd{list-style:none;padding:0;margin:0}
.comp{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--panel)}
.comp-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:.875rem;font-weight:600}
.pill.operational{color:var(--ok)}.pill.degraded{color:var(--warn)}.pill.outage{color:var(--bad)}.pill.unknown{color:var(--muted)}
.bars{display:flex;gap:2px;height:30px;direction:ltr;margin-bottom:6px}
.b{flex:1 1 0;min-width:2px;border-radius:2px;background:var(--line)}
.b.up{background:var(--ok)}.b.part{background:var(--warn)}.b.down{background:var(--bad)}
.inc{border:1px solid var(--line);border-inline-start:4px solid var(--warn);border-radius:10px;padding:12px 16px;margin-bottom:12px;background:var(--panel)}
.inc-outage{border-inline-start-color:var(--bad)}
.tag{border:1px solid var(--gold);color:var(--lift);border-radius:999px;padding:0 8px;font-size:.78rem}
.upd{margin-top:8px}.upd li{padding:6px 0;border-top:1px solid var(--line)}
footer{border-top:1px solid var(--line);margin-top:48px;padding-block:20px}
`.replace(/\n/g, '');

export function renderStatusPage(s: Snapshot, lang: Lang, origin: string): string {
  const t = T[lang];
  const home = lang === 'ar' ? '/' : '/en';
  const alt = lang === 'ar' ? '/en' : '/';
  const icon = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="22" fill="${BRAND.colors.night}"/><g transform="translate(60 60) scale(1.0667) translate(-58 -64)"><path d="M30 100 V56 a28 28 0 0 1 56 0 V100" fill="none" stroke="${BRAND.colors.gold}" stroke-width="13" stroke-linecap="round"/><circle cx="58" cy="74" r="9" fill="${BRAND.colors.lift}"/></g></svg>`
  )}`;
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
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>
<header><div class="wrap row">
<a class="wordmark" href="${home}">${brandMarkSvg({ size: 24, cls: 'wm-mk' })}<span class="wm-l">${BRAND.name.toLowerCase()}</span><span class="wm-a" lang="ar">${BRAND.nameAr}</span><span class="wm-s">${esc(t.site)}</span></a>
<a class="lang" href="${alt}" hreflang="${t.otherLang.lang}" lang="${t.otherLang.lang}">${t.otherLang.label}</a>
</div></header>
<main id="main" class="wrap">
<div class="banner ${s.overall}" role="status"><span class="dot" aria-hidden="true"></span><h1>${esc(t.overall[s.overall])}</h1></div>
<p class="muted small">${esc(t.explain)} ${esc(t.bars)}</p>
<h2>${esc(t.activeIncidents)}</h2>
${active}
<h2>${esc(t.components)}</h2>
<ul class="comps">${s.components.map(c => component(c, lang)).join('')}</ul>
<h2>${esc(t.recentIncidents)}</h2>
${recent}
<p class="muted small">${esc(t.generated)}: <time datetime="${new Date(s.generatedAt).toISOString()}">${fmt(s.generatedAt)}</time> · <a href="/api/status.json">/api/status.json</a></p>
</main>
<footer><div class="wrap muted small">${esc(t.footer)} · <a href="https://${BRAND.domains.help}">${lang === 'ar' ? 'مركز المساعدة' : 'Help centre'}</a> · <a href="https://${BRAND.domains.docs}">${lang === 'ar' ? 'الوثائق' : 'Docs'}</a></div></footer>
</body>
</html>
`;
}

export type { ComponentStatus };
