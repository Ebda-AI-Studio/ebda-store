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
        f => !f.includes(`${path.sep}landing${path.sep}`) && !f.endsWith('liquid-glass-button.tsx')
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
  it('T-07: the decrease button shows a real minus (U+2212), aria-hidden, not an ASCII hyphen', () => {
    expect(pdp).not.toMatch(/>\s*-\s*<\/button>/);
    expect(pdp).toContain('<span aria-hidden="true">−</span>');
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
  it('the classic editor shows the same hint when Bottom corner is picked', () => {
    const page = readFileSync(
      path.resolve(WEB, '../../admin/src/app/stores/[id]/page-builder/page.tsx'),
      'utf8'
    );
    expect(page).toContain("t('sections.hero.textAnchorHint')");
    for (const l of ['en', 'ar']) {
      const msgs = readFileSync(
        path.resolve(WEB, `../../admin/src/i18n/messages/${l}.json`),
        'utf8'
      );
      expect(msgs, l).toContain('"textAnchorHint"');
    }
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
