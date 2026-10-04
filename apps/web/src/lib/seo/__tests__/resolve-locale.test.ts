import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A1 (2026-09-22 AEO audit) root cause: `<html lang>` is resolved in
 * `app/layout.tsx` from the `force-language` cookie, then the store
 * default — but every meta-description/JSON-LD call site defaulted to
 * `'en'` instead of asking this same question, so an Arabic-default store
 * served an English `<meta name="description">` under `lang="ar"`.
 *
 * These tests assert `resolveStorefrontLocale` makes the IDENTICAL decision
 * `RootLayout`'s `resolvedLanguage` makes (cookie wins over store default,
 * store default wins over the 'en' fallback) — the invariant that was
 * broken. Mutation check: reverting `resolve-locale.ts` to always return
 * `'en'` (or dropping the cookie-precedence branch) turns every one of
 * these red.
 */

const cookieBag = { value: new Map<string, string>() };

function setCookie(name: string, val: string | undefined) {
  if (val === undefined) cookieBag.value.delete(name);
  else cookieBag.value.set(name, val);
}

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => {
      const v = cookieBag.value.get(k);
      return v === undefined ? undefined : { name: k, value: v };
    },
  }),
}));

const { resolveStorefrontLocale, localeFromRouteParam } = await import('../resolve-locale');

beforeEach(() => {
  cookieBag.value.clear();
});

describe('resolveStorefrontLocale', () => {
  it('the force-language cookie wins over the store default', async () => {
    setCookie('force-language', 'en');
    await expect(resolveStorefrontLocale('ar')).resolves.toBe('en');
  });

  it('an ar cookie wins over an en store default', async () => {
    setCookie('force-language', 'ar');
    await expect(resolveStorefrontLocale('en')).resolves.toBe('ar');
  });

  it('falls back to the store default when no cookie is set', async () => {
    await expect(resolveStorefrontLocale('ar')).resolves.toBe('ar');
    await expect(resolveStorefrontLocale('en')).resolves.toBe('en');
  });

  it('falls back to ar (Arabic-first, REGION.defaultLocale) when neither cookie nor store default is set', async () => {
    await expect(resolveStorefrontLocale(undefined)).resolves.toBe('ar');
    await expect(resolveStorefrontLocale(null)).resolves.toBe('ar');
  });

  it('ignores a garbage cookie value and falls through to the store default', async () => {
    setCookie('force-language', 'fr');
    await expect(resolveStorefrontLocale('ar')).resolves.toBe('ar');
  });
});

describe('localeFromRouteParam', () => {
  it('only "ar" resolves to ar; everything else (including undefined) is en', () => {
    expect(localeFromRouteParam('ar')).toBe('ar');
    expect(localeFromRouteParam('en')).toBe('en');
    expect(localeFromRouteParam(undefined)).toBe('en');
    expect(localeFromRouteParam('fr')).toBe('en');
  });
});
