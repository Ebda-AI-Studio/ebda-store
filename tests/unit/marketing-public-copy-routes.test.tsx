/**
 * Public-copy rule, route walk: render EVERY marketing page (service lines on, so /services and the studio home are
 * included) and fail on an upcoming claim that is not about Ebda CRM / Ebda ERP, in the markup AND in its JSON-LD, and on
 * any mention of the retired products (Ebda Ads, Ebda Invite, Ebda Quote Studio) as coming soon.
 * (docs/rulings/COMING-SOON-CRM-ERP-ONLY-1.md)
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

vi.mock('next/font/google', () => {
  const font = () => ({ className: '', variable: '', style: {} });
  return { Geist: font, Geist_Mono: font, IBM_Plex_Sans_Arabic: font };
});
vi.hoisted(() => vi.stubEnv('EBDA_SERVICE_LINES', 'on'));
afterAll(() => vi.unstubAllEnvs());

const APP = path.resolve(__dirname, '../../apps/marketing/src/app');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const UPCOMING =
  /coming soon|rolling out|search by meaning|(?<![؀-ۿ])قريب[اً]|جاي قريب|جاية قريب|بحث بالمعنى/i;
const RETIRED = /Ebda (Ads|Invite|Quote Studio)|ابدأ (آدز|إنفايت|ستوديو للتسعير)/;
const SCRIPT = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

const chunks = (html: string) =>
  html
    .replace(/<\/(li|p|div|section|h\d|a|span|article|script)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n|(?<=[.!؟])\s|","/)
    .map(l => l.trim());

describe('no upcoming claim outside CRM/ERP on any page or in its JSON-LD', () => {
  const pages = walk(APP).filter(f => /[\\/]page\.tsx$/.test(f) && !f.includes('_not-found'));
  it('finds the route files', () => expect(pages.length).toBeGreaterThanOrEqual(64));
  for (const file of pages) {
    it(path.relative(APP, file), async () => {
      const { default: Page } = await import(file);
      const html = renderToStaticMarkup(<Page />);
      const bad = chunks(html).filter(l => UPCOMING.test(l) && !/\b(CRM|ERP)\b/.test(l));
      expect(bad.map(l => l.slice(0, 140))).toEqual([]);
      const ld = [...html.matchAll(SCRIPT)].map(m => m[1]).join('\n');
      expect(ld, 'JSON-LD').not.toMatch(UPCOMING);
      expect(`${html}`.match(RETIRED), 'retired product named').toBeNull();
    });
  }
});
