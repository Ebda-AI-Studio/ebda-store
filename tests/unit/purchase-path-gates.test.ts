/**
 * Quality bar § 10 (W4): the purchase path's deterministic gates. The file list and the screen
 * manifest live in docs/ebda/templates/purchase-path.json (one source for the gates and the shots).
 *
 * (b) no unthemed browser defaults: every native radio / checkbox takes the look's accent
 *     (`accent-[hsl(var(--primary))]`), every native select draws on the input token.
 * (c) no colours outside the token set on purchase-path components: no Tailwind palette hues
 *     (green-500, red-50 ...), no `text-white` / `bg-white` / `bg-black`, no hex literals in class
 *     strings. Semantic tokens (primary, accent, destructive, success-ink, warning ...) are the set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'apps/web/src');
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, 'docs/ebda/templates/purchase-path.json'), 'utf8')
) as { viewports: string[]; screens: { id: string; path: string }[]; files: string[] };
const src = (f: string) => readFileSync(path.join(WEB, f), 'utf8');

/** Every opening JSX tag named `name`, brace-aware (an `=>` inside a handler does not end it). */
export function openTags(s: string, name: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let depth = 0;
    let j = m.index!;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 0 && c === '>' && s[j - 1] !== '=') break;
    }
    out.push(s.slice(m.index!, j + 1));
  }
  return out;
}

describe('openTags self-test', () => {
  it('reads past an arrow function inside the tag', () => {
    const t = openTags(
      '<input type="radio" onChange={e => go(e)} className="accent-primary" />',
      'input'
    );
    expect(t[0]).toContain('accent-primary');
  });
});

describe('purchase-path manifest', () => {
  it('every listed file exists', () => {
    for (const f of manifest.files) expect(existsSync(path.join(WEB, f)), f).toBe(true);
  });

  it('lists the Souq-only controls (Phase B2): rail, tiles, stage, instalment line, header', () => {
    for (const f of [
      'templates/shared/CategoryRail.tsx',
      'templates/shared/CategoryTiles.tsx',
      'builder/sections/ProductSpotlightSection.tsx',
      'components/commerce/InstalmentLine.tsx',
      'templates/souq/Header.tsx',
    ])
      expect(manifest.files, f).toContain(f);
  });

  it('the Souq path set points at products the Souq demo catalogue really carries', async () => {
    const t = (
      manifest as unknown as {
        templates: { souq: { secondProductPath: string; paths: Record<string, string> } };
      }
    ).templates.souq;
    const { SOUQ_PRODUCTS, SOUQ_CATEGORIES } =
      await import('../../scripts/souq-demo/catalogue.mjs');
    const bySlug = new Map<string, { options?: unknown[] }>(
      SOUQ_PRODUCTS.map((p: { slug: string; options?: unknown[] }) => [p.slug, p])
    );
    const slugOf = (u: string) => u.replace(/^\/products\//, '');
    // The PDP screens use the Colour x Storage phone (the option-missing screen needs options).
    for (const id of ['pdp', 'pdp-add-missing-option', 'pdp-added'])
      expect(bySlug.get(slugOf(t.paths[id]))?.options?.length, id).toBeGreaterThan(0);
    // The second cart line is option-less, so `two-lines` adds it without choosing anything.
    const second = bySlug.get(slugOf(t.secondProductPath));
    expect(second, 'second product exists').toBeDefined();
    expect(second!.options ?? [], 'second product has no options').toHaveLength(0);
    const cat = new URL(t.paths.category, 'http://x').searchParams.get('category');
    expect(SOUQ_CATEGORIES.map((c: { slug: string }) => c.slug)).toContain(cat);
  });
});

/**
 * Rule (a) (W4): the taste gate scores a look only on the WHOLE purchase path, shot at
 * 390 Arabic and 1280 English. The audit that scored Atelier 24 found its worst defects on
 * screens the self-review never shot (payment step, cart remove, receipt).
 */
describe('(a) the screen manifest covers the whole purchase path', () => {
  const REQUIRED = [
    'home',
    'category',
    'pdp',
    'pdp-add-missing-option',
    'pdp-added',
    'cart',
    'cart-edit',
    'cart-remove',
    'checkout-shipping',
    'checkout-shipping-errors',
    'checkout-shipping-filled',
    'checkout-shipping-error',
    'checkout-payment',
    'checkout-coupon-failed',
    'checkout-chips-selected',
    'receipt',
    'cart-empty',
    'footer',
  ];
  it('viewports are exactly 390 Arabic and 1280 English', () => {
    expect(manifest.viewports).toEqual(['390-ar', '1280-en']);
  });
  it('lists every step from browse to receipt, in path order', () => {
    const ids = (manifest.screens as Array<{ id: string }>).map(s => s.id);
    expect(ids).toEqual(REQUIRED);
  });
  it('the shooting script implements every action the manifest names', async () => {
    const { ACTIONS, viewportOf } = await import('../../scripts/taste/shoot-purchase-path.mjs');
    for (const s of manifest.screens as Array<{ id: string; action?: string }>)
      expect(Object.keys(ACTIONS), s.id).toContain(s.action ?? 'none');
    expect(viewportOf('390-ar')).toMatchObject({ w: 390, lang: 'ar', mobile: true });
    expect(viewportOf('1280-en')).toMatchObject({ w: 1280, lang: 'en', mobile: false });
    expect(typeof manifest.secondProductPath).toBe('string');
  });
  // Set PURCHASE_PATH_SHOTS=<dir>:<prefix>[,<prefix>...] after a shoot to prove every
  // screen x viewport exists for each look (the re-shoot evidence the taste gate reads).
  const shots = process.env.PURCHASE_PATH_SHOTS;
  it.skipIf(!shots)('every screen x viewport was shot for each prefix', () => {
    const [dir, prefixes] = shots!.split(':');
    for (const p of prefixes.split(','))
      for (const s of REQUIRED)
        for (const v of manifest.viewports as string[])
          expect(existsSync(path.join(dir, `${p}-${s}-${v}.png`)), `${p}-${s}-${v}`).toBe(true);
  });
});

describe('(b) no unthemed browser form controls on the purchase path', () => {
  it.each(manifest.files)('%s', f => {
    const s = src(f);
    for (const tag of openTags(s, 'input').filter(t => /type="(radio|checkbox)"/.test(t)))
      expect(tag, `${f}: native radio/checkbox`).toMatch(
        /accent-(?:primary\b|\[hsl\(var\(--primary\)\)\])/
      );
    for (const tag of openTags(s, 'select'))
      expect(tag, `${f}: native select`).toMatch(/border-input/);
  });
});

const OFF_PALETTE =
  /(?:^|[\s"'`])(?:[a-z]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|shadow)-(?:red|green|blue|yellow|emerald|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|orange|amber|slate|gray|zinc|neutral|stone)-\d{2,3}|(?:^|[\s"'`])(?:[a-z]+:)*(?:text|bg)-(?:white|black)(?=[\s"'`/]|$)|\[#[0-9a-fA-F]{3,8}\]/m;

describe('(c) no colours outside the token set on the purchase path', () => {
  it.each(manifest.files)('%s', f => {
    const hits = src(f)
      .split('\n')
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && OFF_PALETTE.test(line))
      .map(({ line, i }) => `${f}:${i} ${line.trim().slice(0, 120)}`);
    expect(hits).toEqual([]);
  });
});

describe('IA-04: purchase-path surfaces take the store radius, never a fixed large radius', () => {
  it.each(manifest.files)('%s', f => {
    const hits = src(f)
      .split('\n')
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(
        ({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /\brounded-(?:xl|2xl|3xl)\b/.test(line)
      )
      .map(({ i }) => `${f}:${i}`);
    expect(hits).toEqual([]);
  });
});

describe('IA-04: the cart summary carries one trust line, not two generic cards', () => {
  it('no "Need Help?" card; one contact line to the store contact page (44px)', () => {
    const cart = src('app/cart/CartClient.tsx');
    expect(cart).not.toContain("'Need Help?'");
    expect(cart).toMatch(/data-testid="cart-help-line"[\s\S]{0,400}storeUrl\('\/contact'\)/);
  });
  it('accepted payments are one inline row, not a bordered card', () => {
    const badges = src('components/AcceptedPaymentBadges.tsx');
    expect(badges).not.toContain("'rounded-[var(--radius)] border border-border bg-card p-4'");
    expect(badges).not.toContain("t('We Accept', 'نقبل الدفع عبر')}\n      </p>");
  });
});

// a11y P1-9 (W4): an inline link told apart by colour alone (receipt "Contact support": 2.75:1
// against its own sentence, no underline at rest) fails 1.4.1. On the purchase path a link or
// text button that underlines on hover is underlined at rest too.
// Ruling B2-21: the stage's product-name link is the section's h2, painted in the foreground ink
// like its neighbours. 1.4.1 is about a link told apart from its sentence by COLOUR alone; a
// heading is told apart by size and weight, so its hover underline is only a hint.
const HEADING_LINK_FILES = new Set(['builder/sections/ProductSpotlightSection.tsx']);
describe('1.4.1: purchase-path text links are underlined at rest', () => {
  it.each(
    [...manifest.files, 'app/checkout/success/SuccessClient.tsx'].filter(
      f => !HEADING_LINK_FILES.has(f)
    )
  )('%s', f => {
    const hits = (src(f).match(/className="[^"]*\bhover:underline\b[^"]*"/g) ?? []).filter(
      c => !/(?:^|[\s"])underline(?=[\s"])/.test(c.replace(/hover:underline/g, ''))
    );
    expect(hits).toEqual([]);
  });
  it('the exempt heading link really is the section h2 and uses the foreground ink', () => {
    const s = src('builder/sections/ProductSpotlightSection.tsx');
    expect(s).toMatch(/<h2[^>]*text-foreground[^>]*>\s*<Link[^>]*hover:underline/);
  });
});

/**
 * a11y re-audit P2-N12 (rule (d) as briefed): inline links in running copy, "Returns within 14
 * days" (PDP) and "Contact support" (receipt), measured 21px high. They keep their line and get a
 * 44px hit inset (before:-inset-y-3 on a 20px line).
 */
describe('(d) inline purchase-path links carry a 44px hit inset', () => {
  it.each([
    ['components/commerce/TrustLine.tsx', "storeUrl('/returns')"],
    ['app/checkout/success/SuccessClient.tsx', "storeUrl('/contact')"],
  ])('%s', (f, href) => {
    const s = src(f);
    const i = s.indexOf(href);
    const tag = s.slice(i, s.indexOf('>', i));
    // -inset-y-4: a 16px line (Lookbook's body at text-sm) measured 40 with -y-3 in the stop4 probe
    expect(tag).toMatch(/className="[^"]*\brelative\b[^"]*\bbefore:-inset-y-4\b/);
  });
});

/**
 * Found by the stop4 rendered probe (rule (d), W5), each measured in the browser:
 *  - checkout checkbox rows (SMS opt-in, save my details): 750x38;
 *  - a Link wrapping a Button (checkout empty state "متابعة التسوق" 120x17): an inline <a>
 *    around a block button measures its line, not the button;
 *  - retry buttons (section and product list): 98-104 x 28.
 */
describe('(d) STOP-2 P1: the shipping clear and retry controls are 44px', () => {
  it('the combobox clear button keeps its 20px glyph and grows a 44px hit area', () => {
    const s = src('app/checkout/_components/GovernorateAreaSelect.tsx');
    const i = s.indexOf('onClick={handleClear}');
    const tag = s.slice(s.lastIndexOf('<button', i), s.indexOf('>', s.indexOf('className=', i)));
    expect(tag).toMatch(/\brelative\b/);
    expect(tag).toMatch(/\bbefore:absolute\b/);
    expect(tag).toMatch(/\bbefore:-inset-3\b/);
  });
  it('the shipping-error Retry button is 44px', () => {
    const s = src('app/checkout/CheckoutClient.tsx');
    const i = s.indexOf('onClick={() => calculateShipping()}');
    const tag = s.slice(s.lastIndexOf('<button', i), s.indexOf('>', s.indexOf('className=', i)));
    expect(tag).toMatch(/\bmin-h-11\b/);
    expect(tag).toMatch(/\bmin-w-11\b/);
  });
});

describe('(d) rendered-probe findings stay fixed', () => {
  it('checkout checkbox rows are 44px', () => {
    const s = src('app/checkout/CheckoutClient.tsx');
    expect(s).toMatch(/data-sms-marketing-optin\s*className="[^"]*\bmin-h-11\b/);
    expect(s).toMatch(/<label className="[^"]*\bmin-h-11\b[^"]*cursor-pointer group">/);
  });
  it.each([
    'app/checkout/CheckoutClient.tsx',
    'app/checkout/error/ErrorClient.tsx',
    'app/cart/CartClient.tsx',
  ])('%s: no bare inline Link around a Button', f => {
    expect(src(f)).not.toMatch(/<Link href=\{[^}]*\}>\s*<Button/);
  });
  it.each(['components/SectionRetryNotice.tsx', 'app/products/ProductsClient.tsx'])(
    '%s: the retry button is 44px',
    f => {
      const s = src(f);
      const i = s.indexOf("t('Retry', 'إعادة المحاولة')");
      const tag = s.slice(s.lastIndexOf('<button', i), i);
      expect(tag).toMatch(/\bmin-h-11\b/);
    }
  );
});

describe('(d) narrow words get width (stop4 probe: crumbs 33-41, See all 39-43 wide)', () => {
  it('breadcrumb links grow sideways too', () => {
    expect(src('components/Breadcrumbs.tsx')).toMatch(/before:-inset-x-2/);
  });
  it('See all links have a 44px minimum width', () => {
    expect(src('templates/shared/SectionHeading.tsx')).toMatch(
      /inline\s*\?\s*`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center/
    );
    expect(src('builder/sections/SectionHeader.tsx')).toMatch(
      /`inline-flex min-h-\[44px\] min-w-11 items-center justify-center rounded-sm/
    );
  });
});

/**
 * The stop4 Vitrine shoot hit the route error fallback on a PDP (a dev compile hiccup): its two
 * actions measured 122-124 x 38. global-error also painted its retry in Tailwind orange, which
 * Ahmad's 2026-10-16 decision rules out. Error surfaces follow the same 44px and token rules.
 */
describe('error surfaces: 44px actions, no palette orange', () => {
  it('RouteErrorFallback actions are 44px', () => {
    const s = src('components/RouteErrorFallback.tsx');
    const tags = [...s.matchAll(/<(?:button|Link)\b[\s\S]*?className="([^"]*)"/g)].map(m => m[1]);
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const c of tags) expect(c).toMatch(/\bmin-h-11\b/);
  });
  it('global-error uses no orange and a 44px retry', () => {
    const s = src('app/global-error.tsx');
    expect(s).not.toMatch(/orange-\d/);
    // no stylesheet is guaranteed there, so the floor is inline too
    expect(s).toMatch(/minHeight: 44/);
  });
});

describe('no Tailwind orange in the storefront (Ahmad 2026-10-16)', () => {
  it('no *-orange-N utility in any storefront file', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap(f => {
        const p = path.join(d, f);
        return statSync(p).isDirectory()
          ? walk(p)
          : /\.tsx?$/.test(f) && !/\.test\./.test(f)
            ? [p]
            : [];
      });
    const hits = walk(WEB).filter(f =>
      /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|shadow)-orange-\d/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(hits.map(f => path.relative(WEB, f))).toEqual([]);
  });
});

describe('(P2) STOP-2 cart and checkout copy and states', () => {
  it('an empty cart says "your cart is empty" once: the h1 is screen-reader only, Egyptian copy', () => {
    const c = src('app/cart/CartClient.tsx');
    expect(c).toMatch(/cartBundles\.length === 0 \? ' sr-only'/);
    expect(c).toContain('سلتك فاضية');
    expect(c).not.toContain('سلة التسوق فارغة');
    expect(c).not.toContain('يبدو أنك لم تضف');
  });
  it('the Area field shows no error while it is still disabled (no governorate yet)', () => {
    const g = src('app/checkout/_components/GovernorateAreaSelect.tsx');
    expect(g).toMatch(/const shownAreaError = governorate \? areaError : undefined;/);
    expect(g).not.toMatch(/hasError=\{!!areaError\}/);
    expect(g).not.toMatch(/\{areaError &&/);
  });
  it('the fixed country is plain text, not an input-shaped box', () => {
    const c = src('app/checkout/CheckoutClient.tsx');
    const i = c.indexOf('{isSingleCountryStore && (');
    const block = c.slice(i, c.indexOf(')}', i));
    expect(block).not.toMatch(/\bborder\b|\brounded-lg\b|<label/);
    expect(block).toMatch(/<p /);
  });
  it('cart and checkout share ONE Apply button style (outline Button), no hand-rolled filled one', () => {
    const cart = src('app/cart/CartClient.tsx');
    const checkout = src('app/checkout/OrderSummary.tsx');
    expect(checkout).toMatch(/<Button type="button" variant="outline" onClick=\{onApplyCoupon\}>/);
    const apply = openTags(cart, 'Button').filter(t => /onClick=\{applyPromoCode\}/.test(t));
    expect(apply.length).toBeGreaterThan(0);
    for (const t of apply) expect(t).toMatch(/variant="outline"/);
    expect(cart).not.toMatch(/<button[^>]*onClick=\{applyPromoCode\}/);
  });
});
