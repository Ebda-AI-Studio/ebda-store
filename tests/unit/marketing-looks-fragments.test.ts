import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_STORES } from '../../apps/marketing/src/lib/site';

// Offline guard on the committed phone fragments (Ruling MKT-PHONES-1). The weekly job
// (.github/workflows/looks-drift.yml) is the network half: it re-snapshots the live demo stores.
const DIR = path.join(__dirname, '../../apps/marketing/public/looks');

describe('committed home-page phones', () => {
  for (const tpl of Object.keys(DEMO_STORES)) {
    const frag = readFileSync(path.join(DIR, `${tpl}.html`), 'utf8');
    const [css, ...looks] = frag.split('<!--look-->');

    it(`${tpl}: <style> then three looks, each a labelled region`, () => {
      expect(css.startsWith('<style>') && css.endsWith('</style>')).toBe(true);
      expect(looks).toHaveLength(3);
      looks.forEach((l, i) => {
        expect(l).toContain(`id="ph-${tpl}-${'abc'[i]}"`);
        expect(l).toMatch(/class="scr"[^>]*role="region"[^>]*aria-label="[^"]+ · [^"]+"/);
      });
    });

    it(`${tpl}: engine bindings exist in every look (cards, cart button, grid)`, () => {
      for (const l of looks) {
        expect(l).toMatch(/data-p-id="[^"]+"[^>]*data-p-name=/);
        expect(l).toContain('data-open-cart');
        expect(l).toContain('data-grid');
        expect(l).toContain('data-p-price=');
      }
    });

    it(`${tpl}: no remote assets, every photo exists, ids are unique`, () => {
      expect(frag).not.toMatch(/(?:src|href|srcset)="https?:\/\/|url\(\s*["']?https?:\/\//);
      expect(frag).not.toMatch(/ebda\.app\/_next|media\.ebda\.app/);
      for (const m of frag.matchAll(/\/looks\/img\/([\w.-]+\.webp)/g))
        expect(existsSync(path.join(DIR, 'img', m[1])), m[1]).toBe(true);
      const ids = [...frag.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it(`${tpl}: no orange, no landmarks or form posts inside a phone`, () => {
      for (const l of looks) {
        expect(l).not.toMatch(/<(?:header|footer|main|nav|form)\b/);
        expect(l).not.toMatch(/<h1\b/);
      }
    });
  }
});
