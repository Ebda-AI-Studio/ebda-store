// @vitest-environment jsdom
/**
 * R-05 (Qamar taste audit 2026-10-15, quality-bar § 2): every accessible name,
 * title, alt and placeholder goes through t(); an Arabic page has no Latin-only
 * name. Before: the PDP wishlist ("Add to wishlist"), the language switcher
 * ("Switch to English"), the skip link, the account "Log out", the checkout
 * "Clear selection", the review stars, the tracking "Copy to clipboard".
 *
 * Gate: render the shared storefront chrome (5 skin headers + Dahab, the tab
 * bar with its menu open, both language-switcher variants, the skip link) under
 * `ar` and collect every name a screen reader would announce. Each must contain
 * Arabic, unless the text sits inside an element whose `lang` is not Arabic (a
 * language's own name, "English") or has no letters at all (a count). Plus a
 * static half: no Latin-only literal in an aria-label / title / alt /
 * placeholder anywhere in apps/web/src.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { code, nodesOf, parseText, stringText } from './helpers/ast-query';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  default: (p: { alt: string; src: string }) => <img alt={p.alt} src={p.src} />,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'ar',
      direction: 'rtl',
      isRtl: true,
      setLanguage: () => {},
      t: (_en: string, ar: string) => ar,
    }),
  };
});
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's1', name: 'متجر', theme: {}, settings: {} },
    isPlatform: false,
    isLoading: false,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ({}),
  useStoreTemplate: () => 'qamar',
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: 'متجر' }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: [],
    bundles: [],
    itemCount: 3,
    total: 0,
    addItem: () => {},
    removeItem: () => {},
    updateQuantity: () => {},
  }),
}));
vi.mock('../../apps/web/src/components/SearchAutocomplete', () => ({
  SearchAutocomplete: () => null,
}));

afterEach(cleanup);

const ARABIC = /[؀-ۿ]/;
const LETTER = /\p{L}/u;

/** The language an element's text is spoken in (nearest `lang`, else Arabic). */
function langOf(el: Element): string {
  const owner = el.closest('[lang]');
  return owner?.getAttribute('lang') ?? 'ar';
}

/** Every announced name in `root` that is Latin-only on an Arabic page. */
function latinOnlyNames(root: HTMLElement): string[] {
  const out: string[] = [];
  const check = (el: Element, kind: string, text: string | null | undefined) => {
    const v = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!v || !LETTER.test(v) || ARABIC.test(v)) return;
    if (langOf(el) !== 'ar') return;
    out.push(`<${el.tagName.toLowerCase()}> ${kind}="${v}"`);
  };
  root
    .querySelectorAll('[aria-label]')
    .forEach(el => check(el, 'aria-label', el.getAttribute('aria-label')));
  root.querySelectorAll('[title]').forEach(el => check(el, 'title', el.getAttribute('title')));
  root.querySelectorAll('img[alt]').forEach(el => check(el, 'alt', el.getAttribute('alt')));
  root
    .querySelectorAll('[placeholder]')
    .forEach(el => check(el, 'placeholder', el.getAttribute('placeholder')));
  // Buttons and links named by their content: check each visible/SR text node in its own lang.
  root.querySelectorAll('button:not([aria-label]), a:not([aria-label])').forEach(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement!;
      if (host.closest('[aria-hidden="true"]')) continue;
      check(host, 'text', n.textContent);
    }
  });
  return out;
}

const branding = { name: 'Store', nameAr: 'متجر' };
const navigation = [
  { label: 'Products', labelAr: 'المنتجات', href: '/products' },
  { label: 'About', labelAr: 'من نحن', href: '/about' },
];

describe('R-05: no Latin-only accessible name on an Arabic page', () => {
  it.each(['base', 'dahab'] as const)('%s header', async skin => {
    const mod = await import(`../../apps/web/src/templates/${skin}/Header.tsx`);
    const Header = mod.default ?? mod.DahabHeader ?? mod.Header;
    const { container } = render(
      <Header
        branding={branding}
        navigation={navigation}
        isRtl
        cartItemCount={3}
        isLoggedIn={false}
        urlPrefix=""
      />
    );
    expect(container.querySelectorAll('a, button').length).toBeGreaterThan(2);
    expect(latinOnlyNames(container)).toEqual([]);
  });

  it('bottom tab bar, menu drawer open', async () => {
    const { BottomTabBar } = await import('../../apps/web/src/templates/shared/BottomTabBar');
    render(<BottomTabBar navigation={navigation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'القائمة' }));
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    expect(latinOnlyNames(document.body)).toEqual([]);
  });

  it('language switcher, both variants', async () => {
    const { LanguageSwitcher } = await import('../../apps/web/src/components/LanguageSwitcher');
    const { container } = render(
      <div>
        <LanguageSwitcher variant="compact" />
        <LanguageSwitcher />
      </div>
    );
    expect(latinOnlyNames(container)).toEqual([]);
    // The compact name is "التبديل إلى English", with "English" voiced in English.
    const compact = container.querySelector('button')!;
    expect(compact.textContent).toContain('التبديل إلى');
    expect(compact.querySelector('[lang="en"]')?.textContent).toBe('English');
  });

  it('skip link', async () => {
    const { SkipLink } = await import('../../apps/web/src/components/SkipLink');
    const { container } = render(<SkipLink />);
    expect(container.textContent).toBe('تخطَّ إلى المحتوى الرئيسي');
  });

  it('the checker catches a Latin-only name (self-test)', () => {
    const { container } = render(
      <div>
        <button aria-label="Add to wishlist">♥</button>
        <a href="#m">Skip to main content</a>
        <span lang="en">
          <button>English</button>
        </span>
        <button aria-label="3">3</button>
      </div>
    );
    expect(latinOnlyNames(container)).toEqual([
      '<button> aria-label="Add to wishlist"',
      '<a> text="Skip to main content"',
    ]);
  });
});

/** Static half: no Latin-only string literal as a name anywhere in the storefront. */
describe('R-05: no Latin-only literal name on a storefront element', () => {
  const ROOT = join(__dirname, '../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  const NOT_A_WORD = /^[\w.+-]+@[\w.-]+$/; // an email example ("you@example.com")
  const NAME_ATTRS = new Set(['aria-label', 'title', 'alt', 'placeholder']);
  const latinOnly = (v: string) => {
    const w = v.trim();
    return /[A-Za-z]/.test(w) && !ARABIC.test(w) && !NOT_A_WORD.test(w);
  };
  /** A string, `{'x'}`, `{`x ${n}`}` -> its words (substitutions become a space); null when not a literal. */
  const literalOf = (n: ts.Node): string | null => stringText(n, ' ');
  type Hit = { file: string; line: number; text: string };

  /**
   * AST scan (JSX attributes, not text positions): a Latin-only literal name on an INTRINSIC element
   * (`<button`, `<img`, lowercase tag; a component prop like `<Carousel title=...>` is not a name), and a name
   * that picks between two Latin-only literals (`{wishlisted ? 'Remove' : 'Add'}`, any element).
   */
  function scanNames(text: string, file: string): Hit[] {
    const sf = parseText(text, file.endsWith('.tsx') ? file : 'snippet.tsx');
    const hits: Hit[] = [];
    for (const n of nodesOf(sf)) {
      if (!ts.isJsxAttribute(n) || !NAME_ATTRS.has(code(n.name)) || !n.initializer) continue;
      const tag = (n.parent.parent as ts.JsxOpeningLikeElement).tagName;
      const intrinsic = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
      const init = ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (!init) continue;
      const lone = literalOf(init);
      const branches = ts.isConditionalExpression(init)
        ? [literalOf(init.whenTrue), literalOf(init.whenFalse)]
        : null;
      const bad =
        (lone !== null && intrinsic && latinOnly(lone)) ||
        (branches !== null && branches.every(b => b !== null && latinOnly(b)));
      if (bad)
        hits.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          text: code(n),
        });
    }
    return hits;
  }
  const scanTree = () =>
    walk(join(ROOT, 'apps/web/src')).flatMap(f =>
      scanNames(readFileSync(f, 'utf8'), f).map(h => `${relative(ROOT, f)}:${h.line}: ${h.text}`)
    );

  it('no intrinsic element carries a Latin-only literal name, and no name picks between two Latin-only literals', () => {
    expect(scanTree()).toEqual([]);
  });

  it('the static matcher catches the old shapes (self-test)', () => {
    const scan = (jsx: string) => scanNames(`const x = (${jsx});`, 'snippet.tsx').length;
    expect(scan('<button aria-label="Log out" />')).toBe(1);
    expect(scan('<button\n  title="Copy to clipboard"\n/>')).toBe(1);
    expect(scan('<button aria-label={`Rate ${star} out of 5`} />')).toBe(1);
    expect(scan('<div aria-label={`${full} of 5 stars`} />')).toBe(1);
    expect(scan('<Carousel title="You May Also Like" titleAr="قد يعجبك" />')).toBe(0);
    expect(scan('<span aria-label={`${i + 1} / ${count}`} />')).toBe(0);
    expect(scan('<input placeholder="you@example.com" />')).toBe(0);
    // the old text scanner lost the tag when an earlier `<` sat inside the same opening tag
    expect(scan('<button onClick={() => n < 3} aria-label="Log out" />')).toBe(1);
    expect(
      scan("<button aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'} />")
    ).toBe(1);
    expect(scan("<button aria-label={isRtl ? 'بحث' : 'Search'} />")).toBe(0);
  });
});
