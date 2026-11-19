/**
 * Renders the status page from a realistic fixture (an active outage, a degraded component, a
 * resolved incident, 90 days of rollups) into .gate/ so the shared axe + Lighthouse gates can
 * scan the exact HTML the Worker serves. No Worker or network is involved.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENTS, HISTORY_DAYS } from '../src/config';
import { renderStatusPage, statusSearchDocs } from '../src/render';
import { HEADLINE_DAYS, uptimeOver } from '../src/uptime';
import { TYPEAHEAD_JS } from '../src/typeahead-bundle';
import type { ComponentSnapshot, Incident, Snapshot } from '../src/types';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.gate');
const now = Date.UTC(2026, 9, 4, 12, 0, 0);
const DAY = 86_400_000;

const components: ComponentSnapshot[] = COMPONENTS.map((c, idx) => {
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => {
    const day = new Date(now - (HISTORY_DAYS - 1 - i) * DAY).toISOString().slice(0, 10);
    const checks = i < 5 ? 0 : 1440;
    const ok = checks && i === 40 + idx ? 1380 : checks && i === 70 ? 1000 : checks;
    return { day, checks, ok };
  });
  const checks = days.reduce((n, d) => n + d.checks, 0);
  const ok = days.reduce((n, d) => n + d.ok, 0);
  return {
    id: c.id,
    status: c.id === 'api' ? 'outage' : c.id === 'docs' ? 'degraded' : 'operational',
    lastChecked: now - 30_000,
    latencyMs: c.id === 'docs' ? 9200 : 120,
    slow: c.id === 'docs',
    lastError: c.id === 'api' ? 'status 503, expected 200' : null,
    uptime: Math.round((ok / checks) * 10000) / 100,
    uptime30d: uptimeOver(days, HEADLINE_DAYS),
    days,
  };
});

const active: Incident[] = [
  {
    id: 2,
    component: 'api',
    title: 'API is not responding',
    titleAr: 'واجهة البرمجة لا يستجيب',
    impact: 'outage',
    status: 'investigating',
    source: 'auto',
    openedAt: now - 20 * 60_000,
    resolvedAt: null,
    updates: [
      {
        at: now - 20 * 60_000,
        status: 'investigating',
        body: '3 consecutive probes failed (status 503, expected 200).',
        bodyAr: 'فشل 3 فحوصات متتالية (status 503, expected 200).',
      },
    ],
  },
  {
    id: 3,
    component: 'docs',
    title: 'Slow docs search',
    titleAr: 'بطء في بحث الوثائق',
    impact: 'degraded',
    status: 'monitoring',
    source: 'manual',
    openedAt: now - 3 * 3_600_000,
    resolvedAt: null,
    updates: [
      {
        at: now - 3_600_000,
        status: 'monitoring',
        body: 'A fix is deployed; watching.',
        bodyAr: 'تم نشر إصلاح ونراقب الوضع.',
      },
      {
        at: now - 3 * 3_600_000,
        status: 'investigating',
        body: 'Search results are slow.',
        bodyAr: 'نتائج البحث بطيئة.',
      },
    ],
  },
];
const recent: Incident[] = [
  {
    id: 1,
    component: 'marketing',
    title: 'Marketing site is not responding',
    titleAr: 'الموقع الرئيسي لا يستجيب',
    impact: 'outage',
    status: 'resolved',
    source: 'auto',
    openedAt: now - 5 * DAY,
    resolvedAt: now - 5 * DAY + 14 * 60_000,
    updates: [
      {
        at: now - 5 * DAY + 14 * 60_000,
        status: 'resolved',
        body: 'Recovered: 2 consecutive probes succeeded.',
        bodyAr: 'عاد للعمل: نجح فحصان متتاليان.',
      },
      {
        at: now - 5 * DAY,
        status: 'investigating',
        body: '3 consecutive probes failed (timeout after 8000ms).',
        bodyAr: 'فشل 3 فحوصات متتالية (timeout).',
      },
    ],
  },
];
const snap: Snapshot = { generatedAt: now, overall: 'outage', components, active, recent };

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'en'), { recursive: true });
writeFileSync(
  path.join(out, 'index.html'),
  renderStatusPage(snap, 'ar', 'https://status.ebda.app')
);
writeFileSync(
  path.join(out, 'en', 'index.html'),
  renderStatusPage(snap, 'en', 'https://status.ebda.app')
);
// Also a healthy snapshot, so both banners are scanned.
mkdirSync(path.join(out, 'ok'), { recursive: true });
writeFileSync(
  path.join(out, 'ok', 'index.html'),
  renderStatusPage(
    {
      ...snap,
      overall: 'operational',
      active: [],
      components: components.map(c => ({ ...c, status: 'operational' })),
    },
    'en',
    'https://status.ebda.app'
  )
);
// What the Worker serves for the live search (the gate serves the files): the script and the English page data.
mkdirSync(path.join(out, 'assets'), { recursive: true });
writeFileSync(path.join(out, 'assets', 'typeahead.js'), TYPEAHEAD_JS);
writeFileSync(path.join(out, 'search.json'), JSON.stringify(statusSearchDocs(snap, 'en')));
console.log(`status snapshot written to ${out} (/, /en/, /ok/)`);
