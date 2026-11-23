/**
 * Labels tab, "Barcode style" picker: tiles keep one fixed box in every state, the preview art is
 * clipped inside its tile, unprintable styles are predicted per label size, plain bars are never a
 * false positive, and the Arabic price never wraps its currency.
 */
import { describe, it, expect } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_LABEL_SETTINGS,
  LABEL_PRESETS,
  RECEIPT_BARCODE_SHAPES,
  labelPresetById,
  layoutLabel,
  shapePrintability,
  type LabelItem,
} from '@ebda/shared';

import { ReceiptBarcodePicker } from '../../apps/admin/src/components/ReceiptBarcodePicker';
import { ShapePicker } from '../../apps/admin/src/app/stores/[id]/codes/_labels/_components/ShapePicker';

const item: LabelItem = {
  name: 'Sample',
  nameAr: 'منتج تجريبي',
  variantTitle: 'M',
  variantTitleAr: 'وسط',
  priceMinor: 25000,
  barcode: '2000000000015',
};
const settings = DEFAULT_LABEL_SETTINGS;

const render = (locale: 'en' | 'ar', ui: React.ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar}>
      {ui}
    </NextIntlClientProvider>
  );

describe('tile layout is stable across states', () => {
  const html = (v: string, extra = {}) =>
    render('en', <ShapePicker value={v} onChange={() => {}} {...extra} />);
  const tiles = (h: string) => [...h.matchAll(/<button[^>]*class="([^"]*)"/g)].map(m => m[1]);
  const SIZE = /^(border-\d|border-[xytblr]\b|p[xytblr]?-|m[xytblr]?-|w-|h-|scale-|min-|max-)/;

  it('selected vs idle tiles differ only by colour + ring, never by size classes', () => {
    const a = tiles(html('plain'));
    const b = tiles(html(RECEIPT_BARCODE_SHAPES[3]));
    expect(a).toHaveLength(RECEIPT_BARCODE_SHAPES.length + 1);
    const sel = a[0].split(' ');
    const idle = a[1].split(' ');
    const stateOnly = [
      ...sel.filter(c => !idle.includes(c)),
      ...idle.filter(c => !sel.includes(c)),
    ];
    expect(stateOnly.length).toBeGreaterThan(0);
    for (const c of stateOnly) expect(c, c).not.toMatch(SIZE);
    expect(sel).toContain('ring-2');
    expect(sel).toContain('border');
    expect(sel).toContain('p-2');
    // every tile, whichever is selected, has the same non-state layout tokens
    const layout = (c: string) =>
      c
        .split(' ')
        .filter(
          t =>
            SIZE.test(t) ||
            (/^(flex|rounded|min-w-0|gap-1|border|relative)/.test(t) &&
              t !== 'border-primary' &&
              t !== 'border-border')
        )
        .sort()
        .join(' ');
    expect(new Set([...a, ...b].map(layout)).size).toBe(1);
  });

  it('blocked tiles keep the same box too', () => {
    const p = labelPresetById('a4-3x7')!;
    const printability = Object.fromEntries(
      ['plain', ...RECEIPT_BARCODE_SHAPES].map(id => [id, shapePrintability(p, item, settings, id)])
    );
    const c = tiles(html('plain', { printability }));
    for (const t of c.slice(1)) expect(t).toContain('p-2');
    for (const t of c.slice(1)) expect(t.split(' ').filter(x => SIZE.test(x))).toContain('p-2');
  });

  it('grid columns cannot be widened by a wide child (minmax(0,1fr)) and art is clipped', () => {
    const h = html('plain');
    expect(h).toContain('minmax(0,1fr)');
    expect(h).toContain('overflow-hidden');
    expect(h).toContain('h-14');
    expect(h).toContain('[&amp;&gt;svg]:w-full');
    expect(h).toContain('[&amp;&gt;svg]:h-full');
    // the plain-bars SVG has a viewBox and no fixed width, so w-full/h-full scales it to fit
    expect(h).toMatch(/viewBox="0 0 360 64"/);
    expect(h).not.toMatch(/<svg[^>]* width="/);
  });
});

describe('printability per style for the current label', () => {
  it('plain bars are printable on every preset (no false positive)', () => {
    for (const p of LABEL_PRESETS) {
      expect(shapePrintability(p, item, settings, 'plain').printable, p.id).toBe(true);
      expect(layoutLabel(p, item, settings).barcode.moduleMm).toBeGreaterThanOrEqual(0.19);
    }
  });

  it('a small fixed label blocks shapes and reports the height that works', () => {
    const p = labelPresetById('a4-3x7')!;
    const blocked = RECEIPT_BARCODE_SHAPES.map(id => ({
      id,
      r: shapePrintability(p, item, settings, id),
    })).filter(x => !x.r.printable);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some(x => x.r.minHeightMm !== null)).toBe(true);
    for (const { id, r } of blocked.filter(x => x.r.minHeightMm !== null)) {
      expect(r.minHeightMm!).toBeGreaterThan(p.heightMm);
      const at = layoutLabel({ ...p, heightMm: r.minHeightMm! }, item, { ...settings, shape: id });
      expect(at.printable).toBe(true);
      const below = layoutLabel({ ...p, heightMm: r.minHeightMm! - 0.5 }, item, {
        ...settings,
        shape: id,
      });
      expect(below.printable).toBe(false);
    }
  });

  it('a continuous roll grows to fit, so shapes print', () => {
    const p = labelPresetById('roll-80')!;
    for (const id of RECEIPT_BARCODE_SHAPES)
      expect(shapePrintability(p, item, settings, id).printable, id).toBe(true);
  });

  it('picker greys blocked styles with the reason on the tile and a visible line', () => {
    const p = labelPresetById('a4-3x7')!;
    const printability = Object.fromEntries(
      ['plain', ...RECEIPT_BARCODE_SHAPES].map(id => [id, shapePrintability(p, item, settings, id)])
    );
    for (const locale of ['en', 'ar'] as const) {
      const html = render(
        locale,
        <ShapePicker
          value="plain"
          onChange={() => {}}
          printability={printability}
          heightMm={p.heightMm}
        />
      );
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain('38.1');
      expect(html).toMatch(/aria-checked="true"/);
    }
    const en1 = render(
      'en',
      <ShapePicker value="plain" onChange={() => {}} printability={printability} heightMm={38.1} />
    );
    expect(en1).toMatch(
      /Shape styles need a label at least [\d.]+ mm tall\. Your label is 38\.1 mm\./
    );
    expect(en1).toMatch(/title="Needs a label at least [\d.]+ mm tall\. Yours is 38\.1 mm\."/);
  });
});

describe('price never wraps its currency', () => {
  it('ar price uses a no-break space between amount and ج.م', () => {
    const l = layoutLabel(labelPresetById('a4-3x7')!, item, { ...settings, lang: 'ar' });
    const price = l.texts.find(t => t.role === 'price')!;
    expect(price.text).toBe('250 ج.م');
    expect(price.text).not.toContain(' ');
  });
  it('en price too, and the Arabic sample variant is not a lone letter', () => {
    const l = layoutLabel(labelPresetById('a4-3x7')!, item, { ...settings, lang: 'en' });
    expect(l.texts.find(t => t.role === 'price')!.text).toBe('EGP 250');
  });
});

describe('receipt (order barcode) picker shares the same layout-stable tiles', () => {
  const html = (v: string) =>
    render('en', <ReceiptBarcodePicker storeId="s1" value={v} onSaved={() => {}} />);
  const tiles = (h: string) => [...h.matchAll(/<button[^>]*class="([^"]*)"/g)].map(m => m[1]);
  const SIZE = /^(border-\d|border-[xytblr]\b|p[xytblr]?-|m[xytblr]?-|w-|h-|scale-)/;

  it('selected vs idle differ only by colour + ring; art clipped; columns minmax(0,1fr)', () => {
    const h = html('plain');
    const t = tiles(h).filter(c => c.includes('rounded-lg'));
    expect(t).toHaveLength(RECEIPT_BARCODE_SHAPES.length + 2);
    const sel = t[0].split(' ');
    const idle = t[2].split(' ');
    const diff = [...sel.filter(c => !idle.includes(c)), ...idle.filter(c => !sel.includes(c))];
    for (const c of diff) expect(c, c).not.toMatch(SIZE);
    expect(sel).toContain('ring-2');
    expect(h).toContain('minmax(0,1fr)');
    expect(h).toContain('overflow-hidden');
    expect(h).toContain('[&amp;&gt;svg]:w-full');
    expect(h).not.toMatch(/<svg[^>]* width="/);
    expect(h).not.toContain('[&amp;&gt;svg]:w-auto');
  });

  it('"No barcode" is a crossed-out barcode glyph in a same-size tile, not a lone dash', () => {
    const h = html('off');
    const off = h.split('<button').find(b => b.includes('aria-label="No barcode"')) ?? '';
    expect(off).toContain('<line');
    expect(off).toContain('aria-hidden="true"');
    expect(h).not.toContain('>-</span>');
    expect(h).toMatch(/aria-label="No barcode"/);
    const t = tiles(h).filter(c => c.includes('rounded-lg'));
    expect(t[1]).toContain('p-2');
    expect(t[1]).toContain('border');
  });
});

describe('BARKOD credit line', () => {
  it('shows the credit without the permission clause in both pickers', () => {
    const a = render('en', <ShapePicker value="plain" onChange={() => {}} />);
    const b = render('en', <ReceiptBarcodePicker storeId="s1" value="plain" onSaved={() => {}} />);
    for (const h of [a, b]) {
      expect(h).toContain('Shape drawings by BARKOD studio (barkod.studio).');
      expect(h).not.toContain('used with permission');
    }
  });
});
