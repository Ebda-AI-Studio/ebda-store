/** Regenerates public/llms-full.txt from the same data as /features and /compare. Run: npm run llms-full -w @ebda/marketing */
import { writeFileSync } from 'node:fs';
import { CAPABILITIES, CAPABILITY_IDS, FEATURES_FAQ, MORE } from '../src/lib/capabilities';
import { COMPARE, GAP_ROWS, STRENGTH_ROWS, COMPARE_AS_OF } from '../src/lib/compare';

const L: string[] = [];
L.push('# Ebda Store (ابدأ ستور) — full capability list');
L.push('');
L.push(
  '> Ebda Store — ابدأ ستور, by Ebda AI Studio (ebda.app). A self-serve online store builder for sellers in Egypt, Arabic-first with English. Not to be confused with any other site named Ebda. Generated from the same source as https://ebda.app/en/features/ and /en/compare/*; short version: https://ebda.app/llms.txt'
);
L.push('');
L.push(
  'Pricing (EGP per month): Basic 1,490, Growth 3,490, Business 9,990; yearly billing saves 25%; 14-day free Growth trial; 0% commission on every plan. Sign up: https://store.ebda.app/signup'
);
L.push('');
L.push('## Capabilities');
for (const id of CAPABILITY_IDS) {
  const c = CAPABILITIES.en[id];
  L.push(`### ${c.t}`);
  L.push(c.d + (c.plan ? ` Available on: ${c.plan}.` : ''));
  L.push(`Arabic: ${CAPABILITIES.ar[id].t}`);
  L.push('');
}
L.push(`## ${MORE.en.title}`);
for (const i of MORE.en.items) L.push(`- ${i}`);
L.push('');
L.push('## FAQ');
for (const f of FEATURES_FAQ.en) {
  L.push(`Q: ${f.q}`);
  L.push(`A: ${f.a}`);
  L.push('');
}
L.push(`## Comparisons (as of ${COMPARE_AS_OF})`);
L.push('Competitor facts are general and publicly known; check their sites before deciding.');
L.push('');
for (const slug of ['salla', 'zid', 'shopify'] as const) {
  const d = COMPARE[slug];
  L.push(`### ${d.en.title} — https://ebda.app/en/compare/${slug}/`);
  L.push(d.en.intro);
  for (const r of [...STRENGTH_ROWS, ...GAP_ROWS]) {
    L.push(`- ${r.label.en}: Ebda Store — ${r.ebda.en} ${d.en.name} — ${d.cells[r.id].text.en}`);
  }
  L.push('');
}
writeFileSync('public/llms-full.txt', L.join('\n'));
