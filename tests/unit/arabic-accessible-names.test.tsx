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
  useStoreTemplate: () => 'minimal',
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
  it.each(['minimal', 'classic', 'modern', 'bold', 'elegant', 'dahab'] as const)(
    '%s header',
    async skin => {
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
    }
  );

  it.each(['bold', 'modern'] as const)(
    '%s header menu (R-04 fix round): a Sheet; closed holds no links, Escape returns focus',
    async skin => {
      const mod = await import(`../../apps/web/src/templates/${skin}/Header.tsx`);
      const Header = mod.default;
      const { container } = render(
        <Header branding={branding} navigation={navigation} isRtl cartItemCount={0} urlPrefix="" />
      );
      const dialogEl = container.querySelector('dialog')!;
      expect(dialogEl).not.toBeNull();
      expect(dialogEl.querySelectorAll('a').length).toBe(0); // closed: nothing tabbable
      const burger = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
      burger.focus();
      fireEvent.click(burger);
      expect(dialogEl.hasAttribute('open')).toBe(true);
      expect(dialogEl.querySelectorAll('a').length).toBe(navigation.length);
      expect(latinOnlyNames(dialogEl)).toEqual([]);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(dialogEl.hasAttribute('open')).toBe(false);
      expect(document.activeElement).toBe(burger);
    }
  );

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
  // aria-label="Log out", title="Copy to clipboard", aria-label={`Rate ${n} out of 5`}, alt="photo".
  const LITERAL =
    /\b(?:aria-label|title|alt|placeholder)=(?:"([^"{]*[A-Za-z][^"{]*)"|\{\s*[`'"]([^`'"]*[A-Za-z][^`'"]*)[`'"]\s*\})/g;

  /** Is the attribute at `idx` on an intrinsic element (`<button`, `<img`), not a component prop? */
  const onIntrinsic = (src: string, idx: number) =>
    /^<[a-z]/.test(src.slice(src.lastIndexOf('<', idx)));
  /** Text a reader hears: template expressions (`${n}`) are values, not words. */
  const words = (v: string) => v.replace(/\$\{[^}]*\}/g, ' ');
  const NOT_A_WORD = /^[\w.+-]+@[\w.-]+$/; // an email example ("you@example.com")

  it('no intrinsic element carries a Latin-only literal name', () => {
    const hits = walk(join(ROOT, 'apps/web/src')).flatMap(f => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(LITERAL)]
        .filter(m => {
          const v = words(m[1] ?? m[2] ?? '').trim();
          return (
            onIntrinsic(src, m.index!) &&
            /[A-Za-z]/.test(v) &&
            !ARABIC.test(v) &&
            !NOT_A_WORD.test(v)
          );
        })
        .map(m => `${relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`);
    });
    expect(hits).toEqual([]);
  });

  // aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}: both branches Latin.
  const LATIN_TERNARY =
    /\b(?:aria-label|title|alt|placeholder)=\{[\w.!\s]+\?\s*(['"`])([^'"`]*)\1\s*:\s*(['"`])([^'"`]*)\3\s*\}/g;
  const latinPair = (m: RegExpMatchArray) =>
    [m[2], m[4]].every(v => /[A-Za-z]/.test(words(v)) && !ARABIC.test(v));

  it('no name picks between two Latin-only literals', () => {
    const hits = walk(join(ROOT, 'apps/web/src')).flatMap(f => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(LATIN_TERNARY)]
        .filter(latinPair)
        .map(m => `${relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`);
    });
    expect(hits).toEqual([]);
    const probe = "aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}";
    expect([...probe.matchAll(LATIN_TERNARY)].filter(latinPair)).toHaveLength(1);
    const ok = "aria-label={isRtl ? 'بحث' : 'Search'}";
    expect([...ok.matchAll(LATIN_TERNARY)].filter(latinPair)).toHaveLength(0);
  });

  it('the static matcher catches the old shapes (self-test)', () => {
    const scan = (src: string) =>
      [...src.matchAll(LITERAL)].filter(m => {
        const v = words(m[1] ?? m[2] ?? '').trim();
        return (
          onIntrinsic(src, m.index!) && /[A-Za-z]/.test(v) && !ARABIC.test(v) && !NOT_A_WORD.test(v)
        );
      }).length;
    expect(scan('<button aria-label="Log out">')).toBe(1);
    expect(scan('<button\n  title="Copy to clipboard"\n>')).toBe(1);
    expect(scan('<button aria-label={`Rate ${star} out of 5`}>')).toBe(1);
    expect(scan('<div aria-label={`${full} of 5 stars`}>')).toBe(1);
    expect(scan('<Carousel title="You May Also Like" titleAr="قد يعجبك" />')).toBe(0);
    expect(scan('<span aria-label={`${i + 1} / ${count}`}>')).toBe(0);
    expect(scan('<input placeholder="you@example.com" />')).toBe(0);
  });
});
