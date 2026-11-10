/**
 * Pre-QA sweep finding 9 (2026-11-10): the look previews on ebda.app are a build artefact
 * (`npm run looks -w apps/marketing` writes apps/marketing/public/looks/<template>.html from
 * scripts/looks/*.py). Ruling B1-102 moved Lookbook's accent from saffron to moon silver in the
 * generator, but the published file was never regenerated, so the bundle and quick-add buttons
 * stayed amber on the live page. This reads the file that ships, not the generator.
 *
 * A product's own colour option (`data-p-colors`, the swatch that names what the photo shows)
 * is catalogue data, not interface colour, and is left out (Ruling B1-102, amended 2026-11-10).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isForbiddenOrange } from './helpers/orange-gate';

const R = join(__dirname, '../..');
const html = readFileSync(join(R, 'apps/marketing/public/looks/qamar.html'), 'utf8');
const generator = readFileSync(join(R, 'apps/marketing/scripts/looks/qamar.py'), 'utf8');

/** Every hex colour in the interface: styles and markup, minus product colour options. */
function interfaceHexes(source: string): string[] {
  const chrome = source.replace(/data-p-colors="[^"]*"/g, '');
  return [...new Set((chrome.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map(h => h.toUpperCase()))];
}

describe('published Qamar look preview (apps/marketing/public/looks/qamar.html)', () => {
  it('has no orange-family colour in its interface', () => {
    expect(interfaceHexes(html).filter(isForbiddenOrange)).toEqual([]);
  });

  it('Lookbook (look b) paints its accent and buttons in moon silver', () => {
    const tokens = /#ph-qamar-b\{[^}]*\}/.exec(html)![0];
    expect(tokens).toContain('--ac:#D9DCEB');
    expect(tokens).toContain('--btn:#D9DCEB');
    // The bundle button and the 40x40 quick-add button are painted directly, not via --btn.
    for (const cls of ['x-btn', 'qa']) {
      const rule = new RegExp(`#ph-qamar-b \\.${cls}\\{[^}]*\\}`).exec(html);
      expect(rule, `#ph-qamar-b .${cls} rule`).not.toBeNull();
      expect(rule![0]).toContain('background:#D9DCEB');
      expect(rule![0]).toContain('color:#1e2340');
    }
  });

  it('agrees with its generator on the Lookbook token line (a stale export fails here)', () => {
    const line = /--ac:(#[0-9A-Fa-f]{6});--btn:(#[0-9A-Fa-f]{6});--btnfg:#1e2340/.exec(generator)!;
    expect(html).toContain(`--ac:${line[1]};--btn:${line[2]};--btnfg:#1e2340`);
  });
});
