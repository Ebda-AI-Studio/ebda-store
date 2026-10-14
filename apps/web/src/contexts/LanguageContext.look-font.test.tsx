// @vitest-environment jsdom
/**
 * Looks: the body face of a look store is `[data-look] { font-family: var(--font-body) }` in
 * globals.css. LanguageProvider used to write an inline `body.style.fontFamily` on hydration,
 * which beats any stylesheet rule, so no look store ever painted its body font (found in the
 * Phase S browser check: lamma.market's Almarai body rendered as IBM Plex Sans Arabic). A look
 * store now gets no inline font; a legacy store keeps exactly the old inline value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LanguageProvider } from './LanguageContext';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute('data-look');
  document.body.style.fontFamily = '';
});

describe('LanguageProvider body font', () => {
  it('a look store (body[data-look]) gets no inline font-family, in either locale', () => {
    for (const lang of ['ar', 'en'] as const) {
      document.body.setAttribute('data-look', 'lamma.market');
      document.body.style.fontFamily = 'serif'; // a stale value must be cleared too
      render(<LanguageProvider defaultLanguage={lang}>x</LanguageProvider>);
      expect(document.body.style.fontFamily, lang).toBe('');
      cleanup();
    }
  });

  it('a legacy store keeps the locale inline font-family', () => {
    render(<LanguageProvider defaultLanguage="ar">x</LanguageProvider>);
    expect(document.body.style.fontFamily).toContain('var(--font-arabic)');
    cleanup();
    document.cookie = 'force-language=en; path=/';
    render(<LanguageProvider defaultLanguage="en">x</LanguageProvider>);
    expect(document.body.style.fontFamily).toBe('var(--font-sans), sans-serif');
  });
});
