// Ebda AI Studio's founder in the ebda.app entity graph (Ahmad, 2026-11-11): every Organization node of the studio
// names Ahmad Sharaf under the same Person @id mypovonai.com and whisky11.com publish, so the three graphs join; and
// llms.txt names him. Nothing about any other company of his belongs on ebda.app.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as seo from '../../apps/marketing/src/lib/seo';

const PERSON = 'https://mypovonai.com/#person';
const ORG = 'https://ebda.app/#organization';
type Node = { '@id'?: string; founder?: { '@id': string; sameAs: readonly string[] } };
const studioOrgs = (graph: { '@graph': Node[] }) => graph['@graph'].filter(n => n['@id'] === ORG);

describe('Ebda AI Studio founder entity', () => {
  it('the studio Organization carries founder = the shared Person @id, with mypovonai.com sameAs', () => {
    expect(seo.FOUNDER['@id']).toBe(PERSON);
    expect(seo.FOUNDER.sameAs).toEqual(['https://mypovonai.com']);
    for (const locale of ['ar', 'en'] as const) {
      const graphs = [seo.studioJsonLd(locale), seo.jsonLd(locale), seo.whatsappJsonLd(locale, [])];
      for (const g of graphs) {
        const orgs = studioOrgs(g as unknown as { '@graph': Node[] });
        expect(orgs.length).toBeGreaterThan(0);
        for (const o of orgs) expect(o.founder?.['@id']).toBe(PERSON);
      }
    }
  });

  it('llms.txt names the founder; neither llms file mentions Force AI', () => {
    const llms = readFileSync('apps/marketing/public/llms.txt', 'utf8');
    expect(llms).toContain('Founder: Ahmad Sharaf (https://mypovonai.com).');
    for (const f of ['llms.txt', 'llms-full.txt'])
      expect(readFileSync(`apps/marketing/public/${f}`, 'utf8')).not.toMatch(/Force AI/i);
  });
});
