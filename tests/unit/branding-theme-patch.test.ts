/**
 * Branding save must not write the display defaults into `stores.theme`.
 *
 * The page shows `{ ...DEFAULT_THEME, ...store.theme }` so every picker has a
 * value. It used to PUT that merged object, and the theme PUT is a
 * shallow-merge PATCH: on a look store with an empty theme that wrote ~13
 * look-owned keys as defaults, burying the look (`composeStoreTheme` lets
 * `stores.theme` win) and badging every key "edited". The save now sends
 * `themePatch(loaded, current)` — only the keys the merchant changed here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOK_TOKEN_KEYS } from '@ebda/shared';
import { DEFAULT_THEME, type StoreTheme } from '@admin/app/stores/[id]/branding/_components/types';
import { themePatch } from '@admin/app/stores/[id]/branding/_hooks/theme-patch';

/** What `useBranding` shows for a store whose stored theme is `stored`. */
const shown = (stored: Partial<StoreTheme>): StoreTheme => ({ ...DEFAULT_THEME, ...stored });

describe('Branding theme save sends only changed keys', () => {
  it('a look store with an empty theme saving a logo/phone change sends no theme keys', () => {
    const loaded = shown({});
    // The merchant only edited logo + phone: branding.theme is untouched.
    const current = { ...loaded };
    const patch = themePatch(loaded, current);
    expect(patch).toEqual({});
    for (const key of LOOK_TOKEN_KEYS) expect(patch).not.toHaveProperty(key);
  });

  it('changing one colour sends exactly that key', () => {
    const loaded = shown({});
    const current = { ...loaded, primaryColor: '10 80% 40%' };
    expect(themePatch(loaded, current)).toEqual({ primaryColor: '10 80% 40%' });
  });

  it('a stored key the merchant did not touch is not re-sent', () => {
    const loaded = shown({ accentColor: '1 2% 3%', logoSize: 'lg' });
    const current = { ...loaded, showQuickAdd: true };
    expect(themePatch(loaded, current)).toEqual({ showQuickAdd: true });
  });

  it('a key the page removed is sent as null (the theme PUT deletes it)', () => {
    const loaded = shown({ footerLogo: 'https://x/l.png' });
    const current = { ...loaded };
    delete current.footerLogo;
    expect(themePatch(loaded, current)).toEqual({ footerLogo: null });
  });

  it('useBranding PUTs the patch, never the merged theme', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/admin/src/app/stores/[id]/branding/_hooks/useBranding.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/apiPut\([^)]*\/theme`,\s*branding\.theme\)/);
    expect(src).toMatch(/themePatch\(/);
  });

  it('the page-builder theme PUT sends only its staged keys, not the load snapshot', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/admin/src/app/stores/[id]/page-builder/page.tsx'),
      'utf8'
    );
    const put = src.match(/apiPut\(`\/api\/v1\/stores\/\$\{storeId\}\/theme`,[\s\S]*?\)/);
    expect(put?.[0]).toBeDefined();
    expect(put![0]).not.toMatch(/storeInfo/);
  });
});
