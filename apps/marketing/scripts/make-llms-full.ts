/**
 * Regenerates public/llms-full.txt and the generated capability block of public/llms.txt from the same data
 * as /features and /compare (capability registry included, so a `coming` item says so everywhere).
 * Run: npm run llms-full -w @ebda/marketing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CAPABILITIES, MORE, THEMES, THEME_COPY, featuresFaq } from '../src/lib/capabilities';
import { COMING_LABEL, REGISTRY } from '../src/lib/capability-registry';
import { COMPARE, COMPARE_AS_OF, compareRows } from '../src/lib/compare';
import { COMPARE_SLUGS } from '../src/lib/site';
import { socialLinks } from '@ebda/shared/brand';

const SOON = COMING_LABEL.en.toLowerCase(); // "coming soon"
const coming = (id: keyof typeof REGISTRY) => REGISTRY[id].status === 'coming';

// ---- llms.txt: the generated block between the markers
const brief: string[] = ['## Capabilities'];
for (const t of THEMES) {
  brief.push(`### ${THEME_COPY.en[t.id].title}`);
  for (const id of t.ids) {
    const c = CAPABILITIES.en[id];
    const plan = c.plan ?? c.note;
    brief.push(
      `- ${c.t}${plan ? ` (${plan})` : ''}${coming(id) ? ` — ${SOON}, not live yet` : ''}`
    );
    if (c.soon) brief.push(`  - ${c.soon.text}${coming(c.soon.needs) ? ` (${SOON})` : ''}`);
  }
}
brief.push('');
brief.push('## Not there yet (stated plainly)');
const rows = compareRows();
for (const r of rows.gap) brief.push(`- ${r.label.en}: ${r.ebda.en}`);
brief.push('Ebda Store is a newer platform than Zid or Shopify, with fewer integrations.');
brief.push('');

const llms = readFileSync('public/llms.txt', 'utf8');
const start = llms.indexOf('<!-- capabilities:start');
const endMarker = '<!-- capabilities:end -->';
const end = llms.indexOf(endMarker);
const startLineEnd = llms.indexOf('\n', start) + 1;
writeFileSync(
  'public/llms.txt',
  llms.slice(0, startLineEnd) + brief.join('\n') + '\n' + llms.slice(end)
);

// ---- llms-full.txt
const L: string[] = [];
L.push('# Ebda Store (ابدأ ستور) — full capability list');
L.push('');
L.push(
  '> Ebda Store — ابدأ ستور, by Ebda AI Studio (ebda.app). A self-serve online store builder for sellers in Egypt, Arabic-first with English. Not to be confused with any unrelated site with a similar name. Generated from the same source as https://ebda.app/en/features/ and /en/compare/*; short version: https://ebda.app/llms.txt'
);
L.push('');
L.push(
  'Pricing (EGP per month): Basic 1,490, Growth 3,490, Business 9,990; yearly billing saves 25%; 14-day free Growth trial; 0% commission on every plan. Sign up: https://store.ebda.app/signup'
);
L.push('');
for (const t of THEMES) {
  L.push(`## ${THEME_COPY.en[t.id].title}`);
  L.push(THEME_COPY.en[t.id].lead);
  L.push('');
  for (const id of t.ids) {
    const c = CAPABILITIES.en[id];
    L.push(`### ${c.t}`);
    if (coming(id)) L.push(`Status: ${SOON}, not live yet.`);
    L.push(c.d + (c.plan ? ` Available on: ${c.plan}.` : '') + (c.note ? ` ${c.note}` : ''));
    if (c.soon) L.push(`${c.soon.text}${coming(c.soon.needs) ? ` (${SOON})` : ''}`);
    L.push(`Arabic: ${CAPABILITIES.ar[id].t}`);
    L.push('');
  }
}
L.push(`## ${MORE.en.title}`);
for (const i of MORE.en.items) L.push(`- ${i}`);
L.push('');
L.push('## FAQ');
for (const f of featuresFaq('en')) {
  L.push(`Q: ${f.q}`);
  L.push(`A: ${f.a}`);
  L.push('');
}
L.push(`## Comparisons (as of ${COMPARE_AS_OF})`);
L.push(
  'Competitor facts come from their public pages (Wuilt, YouCan, EasyOrders and ExpandCart were read on 22 October 2026; the others are general and say to check their sites). Check their sites before deciding.'
);
L.push('');
for (const slug of COMPARE_SLUGS) {
  const d = COMPARE[slug];
  L.push(`### ${d.en.title} — https://ebda.app/en/compare/${slug}/`);
  L.push(d.en.intro);
  for (const r of [...rows.strength, ...rows.gap]) {
    L.push(`- ${r.label.en}: Ebda Store — ${r.ebda.en} ${d.en.name} — ${d.cells[r.id].text.en}`);
  }
  L.push('');
}
L.push('## Social');
for (const s of socialLinks('en')) L.push(`- ${s.label}: ${s.href}`);
L.push('');
writeFileSync('public/llms-full.txt', L.join('\n'));
