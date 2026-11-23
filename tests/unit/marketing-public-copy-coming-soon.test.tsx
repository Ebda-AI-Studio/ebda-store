/**
 * Public-copy rule (Ahmad): "coming soon" / "rolling out" is allowed ONLY for Ebda CRM and Ebda ERP. Everything else on the
 * public marketing surface states what exists. Fails on any other product, capability or feature described as upcoming, in
 * the rendered pages, the FAQ (page + JSON-LD source), the compare tables and llms.txt / llms-full.txt.
 * Supersedes SERVICES-IA-1 / SUBDOMAIN-SOON-2 (docs/rulings/COMING-SOON-CRM-ERP-ONLY-1.md).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FeaturesPage } from '../../apps/marketing/src/components/FeaturesPage';
import { Home } from '../../apps/marketing/src/components/Home';
import { ComparePage } from '../../apps/marketing/src/components/ComparePage';
import { featuresFaq } from '../../apps/marketing/src/lib/capabilities';
import { REGISTRY } from '../../apps/marketing/src/lib/capability-registry';
import { compareRows } from '../../apps/marketing/src/lib/compare';
import { COMPARE_SLUGS } from '../../apps/marketing/src/lib/site';
import { BRAND } from '../../packages/shared/src/brand';

const UPCOMING =
  /coming soon|rolling out|rolled out gradually|will be able to|(?<![\u0600-\u06FF])قريب[اً]|جاي قريب|جاية قريب|تدريجيًا|بنطرحه/i;
const ALLOWED = /\b(CRM|ERP)\b/;
const pub = (f: string) =>
  readFileSync(path.resolve(__dirname, '../../apps/marketing/public', f), 'utf8');

/** Every text chunk (tag, sentence or line) that says "upcoming" and does not name CRM or ERP. */
function violations(text: string): string[] {
  return text
    .replace(/<\/(li|p|div|section|h\d|a|span|article)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n|(?<=[.!؟])\s/)
    .filter(l => UPCOMING.test(l) && !ALLOWED.test(l))
    .map(l => l.trim().slice(0, 160));
}

describe('public copy: coming soon is for CRM and ERP only', () => {
  it('no capability is registered as `coming`', () => {
    expect(Object.entries(REGISTRY).filter(([, e]) => e.status === 'coming')).toEqual([]);
  });
  it('the coming-soon product list is CRM and ERP', () => {
    expect(BRAND.comingProducts.map(p => p.id).sort()).toEqual(['crm', 'erp']);
  });
  it('"search by meaning" is not in public copy at all', () => {
    for (const f of ['llms.txt', 'llms-full.txt'])
      expect(pub(f), f).not.toMatch(/search by meaning|بحث بالمعنى/i);
  });
  for (const l of ['ar', 'en'] as const) {
    it(`rendered pages (${l})`, () => {
      const html = [
        renderToStaticMarkup(<FeaturesPage locale={l} />),
        renderToStaticMarkup(<Home locale={l} />),
        ...COMPARE_SLUGS.map(slug => renderToStaticMarkup(<ComparePage locale={l} slug={slug} />)),
      ].join('\n');
      expect(violations(html)).toEqual([]);
      expect(html).not.toMatch(/search by meaning|بحث بالمعنى/i);
    });
    it(`FAQ (${l}) and compare rows`, () => {
      const faq = featuresFaq(l)
        .map(f => `${f.q} ${f.a}`)
        .join('\n');
      expect(violations(faq)).toEqual([]);
      const { strength, gap } = compareRows();
      expect(gap.filter(r => r.soon)).toEqual([]);
      expect(strength.some(r => r.id === 'meaning')).toBe(false);
    });
  }
  for (const f of ['llms.txt', 'llms-full.txt'])
    it(`${f}`, () => expect(violations(pub(f))).toEqual([]));
});
