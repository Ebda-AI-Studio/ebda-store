import { describe, it, expect } from 'vitest';
import { LOOK_TEMPLATES, looksForTemplate } from '@ebda/shared';
import { DEMO_HOSTS } from '../../apps/web/src/lib/demo-hosts';
import { COPY } from '../../apps/marketing/src/lib/content';
import { DEMO_STORES, demoLookUrl, isDemoTemplate } from '../../apps/marketing/src/lib/site';

// Every looks-section tab must link each of its A/B/C looks to its OWN demo host (Ruling TPL-4).
describe('marketing looks section: one demo host per template', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`${locale}: tabs are exactly the template registry`, () => {
      expect(COPY[locale].looks.templates.map(t => t.id)).toEqual([...LOOK_TEMPLATES]);
    });
  }

  for (const tpl of LOOK_TEMPLATES) {
    it(`${tpl}: own demo host, looks in A/B/C order, copy for all three, distinct link`, () => {
      expect(isDemoTemplate(tpl)).toBe(true);
      if (!isDemoTemplate(tpl)) return;
      expect(DEMO_STORES[tpl].host).toBe(DEMO_HOSTS[tpl]);
      const ids = looksForTemplate(tpl)
        .slice()
        .sort((a, b) => a.letter.localeCompare(b.letter))
        .map(l => l.id);
      expect(DEMO_STORES[tpl].looks.map(l => `${tpl}.${l}`)).toEqual(ids);
      for (const locale of ['ar', 'en'] as const) {
        expect(COPY[locale].looks.items[tpl]).toHaveLength(3);
        expect(COPY[locale].looks.items[tpl].every(i => i.name && i.idea)).toBe(true);
      }
      const urls = DEMO_STORES[tpl].looks.map(l => demoLookUrl(tpl, l));
      expect(new Set(urls).size).toBe(3);
      for (const u of urls) expect(u.startsWith(`https://${DEMO_HOSTS[tpl]}.`)).toBe(true);
    });
  }

  it('the five templates use five different hosts', () => {
    expect(new Set(LOOK_TEMPLATES.map(t => DEMO_HOSTS[t])).size).toBe(LOOK_TEMPLATES.length);
  });
});
