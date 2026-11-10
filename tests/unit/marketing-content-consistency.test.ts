/**
 * Content audit 2026-11-10 (C1/C2/C3/C12, Ruling MKT-CONTENT-AUDIT-1): the cheap, enforceable rules behind the launch-eve
 * content fixes, so they cannot drift back.
 *  - C3: the Arabic studio name is always the FULL «ابدأ ستوديو للذكاء الاصطناعي» in copy (the legal entity
 *    «ابدأ ستوديو لتكنولوجيا المعلومات» and the product «ابدأ ستوديو للتسعير» are other names, not truncations).
 *  - C1/C2: a live product (Ebda Store, Ebda Chat) is never listed as coming soon; the 404's coming-soon list IS
 *    BRAND.comingProducts.
 *  - C12: the Store sign-up action has one label, «افتح متجرك» / "Open your store".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand/index';
import { NOT_FOUND } from '../../apps/marketing/src/lib/not-found-copy';
import { comingSoonItems } from '../../apps/marketing/src/lib/coming-soon';

const ROOT = path.resolve(__dirname, '../..');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
/** Every source file that carries public copy: the marketing site, the shared brand, status, help, docs, emails. */
const COPY_FILES = [
  'apps/marketing/src',
  'packages/shared/src/brand',
  'apps/status/src',
  'apps/help/content',
  'apps/api/src/services/email-templates',
]
  .flatMap(d => walk(path.join(ROOT, d)))
  .concat(
    ['apps/marketing/public/llms.txt', 'apps/marketing/public/humans.txt'].map(f =>
      path.join(ROOT, f)
    )
  )
  .filter(f => /\.(ts|tsx|mdx|md|txt)$/.test(f));

const LIVE = [
  BRAND.product.nameAr,
  BRAND.product.nameEn,
  BRAND.productWhatsapp.nameAr,
  BRAND.productWhatsapp.nameEn,
];

describe('content audit rules', () => {
  it('C3: «ابدأ ستوديو» is never truncated in copy', () => {
    const bad: string[] = [];
    for (const f of COPY_FILES) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(
            /ابدأ ستوديو(?! (للذكاء الاصطناعي|لتكنولوجيا المعلومات|للتسعير))/g
          ))
            bad.push(
              `${path.relative(ROOT, f)}:${i + 1} ${line.slice(Math.max(0, m.index! - 20), m.index! + 30)}`
            );
        });
    }
    expect(bad).toEqual([]);
  });

  it('C1/C2: the 404 coming-soon list is BRAND.comingProducts and never names a live product', () => {
    for (const lang of ['ar', 'en'] as const) {
      const soon = NOT_FOUND[lang].groups.flatMap(g => g.links).filter(l => l.soon);
      expect(soon.map(l => l.label)).toEqual(
        BRAND.comingProducts.map(p => (lang === 'ar' ? p.nameAr : p.nameEn))
      );
      for (const l of soon) expect(LIVE).not.toContain(l.label);
      // Ebda Chat is linked as a live product
      const links = NOT_FOUND[lang].groups.flatMap(g => g.links);
      expect(links.some(l => l.href === `https://${BRAND.domains.whatsappApp}/`)).toBe(true);
    }
  });

  it('C1/C2: no coming-soon card on the site names a live product', () => {
    for (const lang of ['ar', 'en'] as const)
      for (const c of comingSoonItems(lang)) expect(LIVE).not.toContain(c.name);
  });

  it('C12: the Store sign-up action has one label', () => {
    const bad: string[] = [];
    for (const f of COPY_FILES.filter(f => f.includes(`${path.sep}marketing${path.sep}src`))) {
      // the Ebda Chat page's own CTA opens the Chat app, a different action with its own label
      if (f.endsWith('whatsapp-page.ts')) continue;
      const s = readFileSync(f, 'utf8');
      for (const label of ['ابدأ دلوقتي', "'Start now'", "'ابدأ متجرك'", "'Start your store'"])
        if (s.includes(label)) bad.push(`${path.relative(ROOT, f)}: ${label}`);
    }
    expect(bad).toEqual([]);
  });
});
