/**
 * W3 polish gates (Qamar taste fix-waves § W3). Each block is one consolidated.md id; each is a
 * class gate over the storefront source, not a check of one file, unless the item names a file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../apps/web/src');
const read = (rel: string) => readFileSync(path.join(WEB, rel), 'utf8');
function files(dir = WEB, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('R-07: Arabic-capable labels never use leading-none (marks clip)', () => {
  it.each(['components/commerce/FactChips.tsx', 'templates/shared/BottomTabBar.tsx'])('%s', f => {
    expect(read(f)).not.toMatch(/\bleading-none\b/);
  });
});

describe('R-15: a text wordmark (store name zone) is never machine-translated', () => {
  it('every data-zone="storeName" element carries translate="no"', () => {
    const misses: string[] = [];
    for (const f of files()) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<[a-zA-Z][^<>]*data-zone="storeName"[^<>]*>/gs))
        if (!/translate="no"/.test(m[0])) misses.push(path.relative(WEB, f));
    }
    expect(misses).toEqual([]);
  });
});

describe('M-04: no transition-all in the storefront (it animates layout and every future property)', () => {
  it('storefront sources and globals.css name the properties they animate', () => {
    const hits = [...files(), path.join(WEB, 'styles/globals.css')]
      .filter(
        f =>
          !path.relative(WEB, f).split(path.sep).includes('landing') &&
          !f.endsWith('liquid-glass-button.tsx')
      )
      .filter(f => /\btransition-all\b/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')))
      .map(f => path.relative(WEB, f));
    expect(hits).toEqual([]);
  });
});

describe('Y-07 / T-07: PDP range and stepper glyphs', () => {
  const pdp = read('app/products/[slug]/ProductDetailClient.tsx');
  it('Y-07: an English price range reads "to", never an en dash', () => {
    expect(pdp).not.toMatch(
      /\$\{formatPrice\(minVariantPrice\)\} – \$\{formatPrice\(maxVariantPrice\)\}`\s*:/
    );
    expect(pdp).toMatch(
      /t\(\s*`\$\{formatPrice\(minVariantPrice\)\} to \$\{formatPrice\(maxVariantPrice\)\}`/
    );
  });
  it('T-07: the decrease button never shows an ASCII hyphen (taste re-audit P2-11: it is now a drawn MinusIcon)', () => {
    expect(pdp).not.toMatch(/>\s*-\s*<\/button>/);
    expect(pdp).toContain('<MinusIcon />');
  });
});

describe('M-3 (B1-57 parked): shared builder sections never use the accent as TEXT on hover', () => {
  it('no builder/sections file has hover:text-accent (rose on Vitrine measured ~2.6:1)', () => {
    const hits = files(path.join(WEB, 'builder/sections')).filter(f =>
      /hover:text-accent(?!-)/.test(readFileSync(f, 'utf8'))
    );
    expect(hits.map(f => path.relative(WEB, f))).toEqual([]);
  });
});

describe('M-6 (B1-57 parked): the editor says why the headline colour is not used under the photo', async () => {
  const { getSectionDefinition } = await import('@ebda/shared');
  it('the hero textAnchor setting carries a bilingual hint (document editor)', () => {
    const d = getSectionDefinition('hero')!.settings.find(s => s.id === 'textAnchor')!;
    expect(d.hintEn).toMatch(/phones and tablets/i);
    expect(d.hintAr).toBeTruthy();
    const panel = readFileSync(
      path.resolve(WEB, '../../admin/src/app/stores/[id]/builder/_components/SettingsPanel.tsx'),
      'utf8'
    );
    expect(panel).toContain('def.hintEn');
  });
});

describe('Y-08 / R-09: cart coupon field and back arrows', () => {
  const cart = read('app/cart/CartClient.tsx');
  it('Y-08: both coupon fields are code fields (no autocorrect, caps, done key)', () => {
    const inputs = [...cart.matchAll(/<input\s+id="cart-promo-code(-t)?"[\s\S]*?\/>/g)].map(
      m => m[0]
    );
    expect(inputs).toHaveLength(2);
    for (const i of inputs) {
      expect(i).toContain('spellCheck={false}');
      expect(i).toContain('autoCapitalize="characters"');
      expect(i).toContain('autoCorrect="off"');
      expect(i).toContain('enterKeyHint="done"');
    }
  });
  it('Y-08: Apply stays enabled while the field is empty (a tap explains / focuses)', () => {
    expect(cart).not.toMatch(/disabled=\{promoApplied \|\| !promoCode \|\| isValidating\}/);
  });
  it('R-09: the back-to-shopping arrows mirror in Arabic', () => {
    const arrows = [...cart.matchAll(/<svg[^>]*>\s*<path[^>]*d="M10 19l-7-7m0 0l7-7m-7 7h18"/g)];
    expect(arrows.length).toBeGreaterThan(0);
    for (const a of arrows) expect(a[0]).toContain('rtl:-scale-x-100');
  });
});

describe('L-07: one filter panel, one clear action, no page-size control', () => {
  const side = read('app/products/ProductsFilterSidebar.tsx');
  const plp = read('app/products/ProductsClient.tsx');
  it('the PLP does not hand the panel a per-page control (a page size is not a filter)', () => {
    expect(plp).not.toMatch(/onPerPageChange=/);
  });
  it('M-1: a page size an old build saved to localStorage is never read, only cleared', () => {
    expect(plp).not.toMatch(/getItem\(['"]plp-per-page['"]\)/);
    expect(plp).toMatch(/localStorage\.removeItem\(PLP_LEGACY_PER_PAGE_KEY\)/);
    expect(plp).toMatch(/useState<number>\(PLP_DEFAULT_PER_PAGE\)/);
  });
  it('one clear action: the header link only, shown only with an active filter', () => {
    expect(side).not.toContain("'Clear All Filters'");
    expect(side).toMatch(/activeCount > 0 && \(\s*<button[\s\S]{0,200}onClick=\{onClearAll\}/);
  });
  it('the panel is named with the article: "الفلاتر"', () => {
    expect(side).not.toContain("t('Filters', 'فلاتر')");
  });
});

describe('R-13: checkout errors move focus, not only the scroll', () => {
  it('CheckoutClient never scrolls to an error without focusFirstError', () => {
    const src = read('app/checkout/CheckoutClient.tsx');
    expect(src).not.toMatch(/\[data-error="true"\]'\)[\s\S]{0,80}scrollIntoView/);
    expect(src.match(/focusFirstError\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('L-08: the desktop PDP gallery stays in view while the buy column scrolls', () => {
  it('the gallery column is sticky from md, under the header, aligned to the top of the grid', () => {
    const src = read('app/products/[slug]/ProductDetailClient.tsx');
    expect(src).toMatch(/className="space-y-4 md:col-span-5 md:sticky md:top-24 md:self-start"/);
  });
});

describe('L-08: the PDP category chip is the phone way back to the category, never a stray label', () => {
  it('a link to the category PLP, phones only (the breadcrumb carries it from md)', () => {
    const src = read('app/products/[slug]/ProductDetailClient.tsx');
    expect(src).not.toMatch(/<Badge variant="secondary">\{categoryName\}<\/Badge>/);
    expect(src).toMatch(
      /className="mt-6 md:hidden"[\s\S]{0,200}href=\{storeUrl\(`\/products\?category=\$\{cat0\.category\.slug\}`\)\}/
    );
  });
});

describe('L-08: the size guide sits beside its label, not at the far edge', () => {
  it('no ms-auto push on the size guide slot', () => {
    const src = read('components/VariantSelector.tsx');
    expect(src).not.toContain('<span className="-my-3 ms-auto">{sizeGuide}</span>');
    expect(src).toContain('<span className="-my-3 ms-2">{sizeGuide}</span>');
  });
});

describe('L-05: a short product row centres (never an empty tail), an overflowing one still scrolls', () => {
  it('the shared carousel track uses safe centring', () => {
    const src = read('templates/shared/ProductCarousel.tsx');
    expect(src).toContain('justify-[safe_center]');
  });
});
