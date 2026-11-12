/**
 * Post-build step of the service-line flag (Ruling SERVICES-IA-1; flag: lib/service-lines.ts, env EBDA_SERVICE_LINES):
 *   off     -> delete the exported /services pages (a static export cannot skip a route, so the pages render notFound() and this
 *              removes their files: the visit then gets the site 404, never a 200 with a not-found body)
 *   preview -> keep the pages (they are noindex in their own markup); nothing is added to llms.txt
 *   on      -> append the Services block to out/llms.txt (public/llms.txt, the source, never changes)
 * Run by `npm run build` after `next build` and before the search index.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@ebda/shared/brand';
import { comingSoonItems } from '../src/lib/coming-soon';
import { SERVICE_LINE_CONTENT, type LineId } from '../src/lib/service-lines-content';
import { serviceLinesMode, type ServiceLinesMode } from '../src/lib/service-lines';
import { SERVICES_META } from '../src/lib/seo';
import { SERVICES_PAGE } from '../src/lib/services-page';

const ORIGIN = `https://${BRAND.domains.marketing}`;

/** The llms.txt block of the published lines (English; each line also links its Arabic page). */
export function servicesLlmsBlock(): string {
  const lines = [
    '## Services',
    `Ebda AI Studio's core is AI, software and consulting and training. It also runs three service lines, each one page: [Services index](${ORIGIN}/en/services/) ([Arabic](${ORIGIN}/services/)): ${SERVICES_PAGE.en.meta.desc}`,
  ];
  for (const l of BRAND.serviceLines) {
    const id = l.id as LineId;
    lines.push(
      `- [${l.nameEn}](${ORIGIN}/en/services/${id}/) ([Arabic: ${l.nameAr}](${ORIGIN}/services/${id}/)): ${SERVICE_LINE_CONTENT[id].en.tagline}. ${SERVICES_META.en[id].desc}`
    );
  }
  const soon = comingSoonItems('en');
  if (soon.length) {
    lines.push('', '## Coming soon (not live yet)');
    for (const s of soon) {
      const ar = BRAND.comingProducts.find(p => p.id === s.id)!.nameAr;
      lines.push(`- ${s.name} (${ar}): ${s.blurb}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function applyServiceLinesPostbuild(out: string, mode: ServiceLinesMode) {
  if (mode === 'off') {
    for (const d of ['services', 'en/services'])
      rmSync(path.join(out, d), { recursive: true, force: true });
  }
  if (mode === 'on') {
    const f = path.join(out, 'llms.txt');
    if (existsSync(f)) {
      const t = readFileSync(f, 'utf8');
      if (!t.includes('## Services'))
        writeFileSync(f, `${t.replace(/\s+$/, '')}\n\n${servicesLlmsBlock()}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
  const mode = serviceLinesMode();
  applyServiceLinesPostbuild(out, mode);
  console.log(`service lines: mode ${mode}`);
}
