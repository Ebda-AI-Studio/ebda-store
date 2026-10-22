/**
 * IA-16 (independent audit): "See all" sat on the heading's baseline in "New in"
 * but below it in "Shop by category" (Lookbook, Vitrine). A start-aligned heading
 * shares one row with its See-all link, aligned on the text baseline, in both the
 * layout sections' SectionHeading and the builder sections' SectionHeader.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '../../apps/web/src');

describe('See all sits on the heading baseline', () => {
  it('builder SectionHeader: title and link share an items-baseline row', () => {
    const src = readFileSync(join(WEB, 'builder/sections/SectionHeader.tsx'), 'utf8');
    expect(src).not.toMatch(/items-end/);
    const row = /data-heading-row[\s\S]*?className=\{?["`]([^"`]*)["`]/.exec(src);
    expect(row?.[1]).toMatch(/\bitems-baseline\b/);
  });

  it('layout SectionHeading: a start-aligned title puts See all on its row', () => {
    const src = readFileSync(join(WEB, 'templates/shared/SectionHeading.tsx'), 'utf8');
    expect(src).toMatch(/const seeAllInline = /);
    const row = /data-heading-row[\s\S]*?className=\{?["`]([^"`]*)["`]/.exec(src);
    expect(row?.[1]).toMatch(/\bitems-baseline\b/);
    expect(src).toMatch(/\{seeAllHref && !seeAllInline && /);
  });
});

// AT-1 (independent audit): "وصل حديثًا" (a builder section) was light while "عبايات"
// (a layout section) was bold. A Qamar store has one section-title style: the builder
// header renders the pack's sectionHeading, so both heading paths share one class string.
describe('one section-title style on a Qamar store (AT-1)', () => {
  it('the builder header uses the pack heading on Qamar and the pack sets one weight', async () => {
    const { getPackStyles } = await import('../../apps/web/src/templates/shared/pack-styles');
    const h = getPackStyles('qamar').sectionHeading;
    expect(h).toMatch(/\bfont-display\b/);
    expect(h.match(/\bfont-(thin|light|normal|medium|semibold|bold|black)\b/g)).toEqual([
      'font-normal',
    ]);
    const src = readFileSync(join(WEB, 'builder/sections/SectionHeader.tsx'), 'utf8');
    // qamar, souq, jasmine and lamma share the pack voice (final review P2-3): `packSkin` is the skin
    expect(src).toMatch(
      /qamar\s*\?\s*`[^`]*\$\{getPackStyles\(packSkin \?\? 'qamar'\)\.sectionHeading\}/
    );
    expect(src).toMatch(
      /packSkin\s*=\s*store\?\.template === 'qamar' \|\|\s*store\?\.template === 'souq'/
    );
  });
});
